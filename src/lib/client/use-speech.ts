"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * Saying what you need, in the browser you already have open.
 *
 * `SpeechRecognition` rather than a recording uploaded for transcription, and
 * the reasoning is the same one that shaped `docs/voice.md`: the useful thing
 * is Swedish, and this is the only Swedish speech path that costs no new
 * secret, no new provider and no new bill. Chrome on Android and Safari on iOS
 * both have it. Firefox has none, and there the button is not drawn at all — a
 * control that cannot work is worse than an absent one, because it teaches you
 * the app is broken rather than that the feature is elsewhere.
 *
 * Whatever is heard lands in the textarea, which means a misheard word is
 * editable before anything is parsed, and the transcript then goes through the
 * same model pass as a paste. No audio leaves as a file.
 *
 * `onTranscript` receives the WHOLE spoken segment each time, not the newest
 * fragment, and the caller is expected to replace rather than append — see
 * `onresult`. One dictation is one segment however many times it is reported.
 */

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

/**
 * Every result of the session so far, settled and unsettled, which is what the
 * engine hands over on each event — not just the part that changed.
 *
 * The event also carries `resultIndex`, "the first result that moved", and this
 * deliberately does not name it. Reading only from there is what broke: see
 * `dictation` below.
 */
export type SpeechResultsLike = ArrayLike<
  ArrayLike<{ transcript: string }> & { isFinal: boolean }
>;

interface SpeechRecognitionEventLike {
  results: SpeechResultsLike;
}

type Ctor = new () => SpeechRecognitionLike;

function ctor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: Ctor;
    webkitSpeechRecognition?: Ctor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Whether this browser has recognition at all, read the way the app reads every
 * other browser-only fact — `useSyncExternalStore`, like `useMode` and
 * `useFridgeGuess`.
 *
 * The obvious shape is `useState(false)` plus an effect that measures and sets;
 * that is a cascading render for a value that never changes after the first
 * paint, and the lint rule says so. This gets the same hydration safety from
 * `getServerSnapshot` instead: the server and the first client render both say
 * "no", and the real answer arrives in the same pass that hydrates. The
 * subscription is empty because nothing can ever change it — a browser does not
 * grow a speech engine while the sheet is open.
 */
function subscribe(): () => void {
  return () => {};
}

function readSupported(): boolean {
  return ctor() !== null;
}

/** No speech during a server render, so the button is simply not drawn yet. */
function serverSupported(): boolean {
  return false;
}

/**
 * One dictation, reading each event as the whole sentence so far.
 *
 * Call it once per session; call the result on every `onresult`. What comes
 * back is everything said since the microphone opened — settled words plus the
 * tail still being guessed at — which is what the sink then puts in the
 * textarea, replacing rather than appending.
 *
 * The rule that matters is that reading the same event twice must produce the
 * same sentence, not twice the sentence. This accumulated instead: each event's
 * newly-final words were APPENDED to a running string, on the assumption that a
 * result goes final exactly once and is then never mentioned again. The
 * assumption holds on a desktop and does not hold on a phone, which re-sends
 * settled results several times over — so "bröd grötbröd", said once into one,
 * arrived as "brödbrödbrödbröd grötbröd grötbröd", each word counted once per
 * event that happened to mention it.
 *
 * So the settled words are stored BY THE INDEX the engine gave them rather than
 * concatenated in arrival order. Hearing result 0 for the fourth time now
 * overwrites result 0 with the same words instead of adding them a fourth time,
 * and the repetition stops mattering. The list is re-read from the start each
 * event for the same reason — `resultIndex` is an optimisation that costs
 * nothing to ignore, and ignoring it means the assembly depends on no promise
 * about which events an engine chooses to send.
 */
export function dictation(): (event: SpeechRecognitionEventLike) => string {
  const settled: string[] = [];

  return (event) => {
    let tail = "";
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const alternative = result?.[0];
      if (!alternative) continue;
      // An unsettled result REPLACES its own earlier guess — "två", "två
      // liter", "två liter mjölk" is one phrase being sharpened, not three.
      if (result.isFinal) settled[i] = alternative.transcript;
      else tail += alternative.transcript;
    }
    return `${settled.join("")}${tail}`.trim();
  };
}

export function useSpeech(onTranscript: (text: string) => void): {
  supported: boolean;
  listening: boolean;
  toggle: () => void;
} {
  const supported = useSyncExternalStore(
    subscribe,
    readSupported,
    serverSupported,
  );
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  /**
   * The callback through a ref, so restarting recognition is not a dependency
   * of every keystroke in the textarea above it.
   *
   * Kept current in an effect rather than assigned during render, for the same
   * reason `useDismissOnOutsidePress` does it: a ref written while rendering is
   * a render with a side effect, and the lint rule says so.
   */
  const sink = useRef(onTranscript);
  useEffect(() => {
    sink.current = onTranscript;
  });

  // Whatever is still listening when the sheet closes must stop listening. The
  // microphone does not belong to a component that no longer exists. Nulled as
  // well as stopped, so the guard below also retires the last instance's late
  // events rather than letting them reach a sink that is gone.
  useEffect(
    () => () => {
      recognition.current?.stop();
      recognition.current = null;
    },
    [],
  );

  const toggle = useCallback(() => {
    if (recognition.current) {
      recognition.current.stop();
      recognition.current = null;
      setListening(false);
      return;
    }

    const Recognition = ctor();
    if (!Recognition) return;

    const rec = new Recognition();

    /**
     * Is `rec` still the instance the hook is driving?
     *
     * Every handler below asks before it touches anything shared, because a
     * stopped `SpeechRecognition` is not a finished one: `stop()` with audio
     * still pending fires one last `onresult` and then `onend`, asynchronously,
     * after the call has returned. So the ordinary stop-and-start-again gesture
     * leaves a retired instance holding live callbacks while a new one runs.
     *
     * Unguarded, everything those callbacks touched was shared by every
     * instance. The settled words were one tally for the whole hook, so session
     * one's trailing words landed in session two's and the sink overwrote the
     * textarea with the mixture — the same bug as the prefix pile-up, arriving
     * by instance-crossing instead of result-index-crossing. And
     * `onend` nulled `recognition.current` unconditionally, so a late one from
     * the OLD instance dropped the reference to the new, still-listening one and
     * flipped the button back to "not listening" while the microphone was open.
     * The tally is now per-session (below); this is what covers the rest.
     *
     * Identity rather than a session counter: `recognition.current` is already
     * the single answer to "which one is live", every path that retires an
     * instance clears or replaces it, and a counter would be a second thing to
     * keep in step with it. Declared here rather than in the component body so
     * it closes over `rec` directly and cannot be captured from a stale render.
     */
    const isCurrent = () => recognition.current === rec;

    /**
     * What THIS session has heard.
     *
     * A closure variable rather than a ref on the hook, which is what makes the
     * isolation structural instead of disciplinary: one tally shared by every
     * instance is what let a retired session's trailing words land in its
     * successor's, and there is no reset to remember or to get wrong, because a
     * new session simply gets a new binding. The guard above still matters — a
     * retired instance must not call the sink or claim the slot — but it is no
     * longer the only thing keeping two sessions apart.
     */
    const say = dictation();

    rec.lang = "sv-SE";
    rec.continuous = true;
    // The words appear as they are said. A silent five seconds followed by a
    // paragraph reads as a hang.
    rec.interimResults = true;
    /**
     * The whole segment said so far, reported every time — it REPLACES rather
     * than appends, and `dictation` above is where that is made true whatever
     * the engine repeats.
     *
     * Nothing is filtered out on the way through: skipping the unsettled
     * results is the obvious repair for a jumpy transcript and the wrong one,
     * because it would take back the live words, and a silent five seconds
     * followed by a paragraph reads as a hang.
     */
    rec.onresult = (event) => {
      if (!isCurrent()) return;
      const segment = say(event);
      if (segment) sink.current(segment);
    };
    rec.onend = () => {
      if (!isCurrent()) return;
      recognition.current = null;
      setListening(false);
    };
    rec.onerror = () => {
      if (!isCurrent()) return;
      recognition.current = null;
      setListening(false);
    };

    recognition.current = rec;
    rec.start();
    setListening(true);
  }, []);

  return { supported, listening, toggle };
}
