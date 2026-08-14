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
 * No audio leaves as a file. What is heard lands in the textarea, which means a
 * misheard word is editable before anything is parsed, and the transcript then
 * goes through the same model pass as a paste.
 *
 * Two things come back out, and keeping them apart is what this hook is for.
 * `live` is the sentence being spoken RIGHT NOW, which moves constantly and is
 * only ever shown. `onUtterance` fires once per finished sentence, and that is
 * the only thing the textarea is ever told about. Nothing that can still change
 * reaches the field.
 */

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

/** Every result of the session so far, settled and unsettled. */
export type SpeechResultsLike = ArrayLike<
  ArrayLike<{ transcript: string }> & { isFinal: boolean }
>;

interface SpeechRecognitionEventLike {
  results: SpeechResultsLike;
}

/**
 * The whole reading rule: THE LAST RESULT IS THE SENTENCE.
 *
 * Not the sum of the results, and not the newest fragment added to what came
 * before. This is the third attempt at this function and the first one that is
 * not arithmetic, because the arithmetic could not be made right: the engines
 * disagree about what a result MEANS, and no way of adding them up survives
 * both readings.
 *
 * Said into a phone, "A B C D E" arrives as five settled results reading "A",
 * "A B", "A B C", "A B C D", "A B C D E" — each one the entire sentence so far,
 * restated at a new index. A desktop sends one result reading "A B C D E".
 * Adding results together gives "AA BA B C…" on the phone, which is how
 * "massvis med gröt" became "massvismassvis med gröt", and how "bröd grötbröd"
 * became "brödbrödbrödbröd grötbröd grötbröd" before it. Taking the last result
 * and nothing else is right on both, and cannot drift, because there is no
 * accumulated state left for a later event to corrupt.
 *
 * `isFinal` is deliberately not read. On that same phone every one of those
 * five results is final, so a sentence is not finished when a result says it
 * is — it is finished when the SESSION is, which is what `onend` is for and why
 * `continuous` is off. Reading `isFinal` here would put five copies of one
 * sentence in the field, which the end-to-end suite proves by trying it.
 */
export function hear(event: SpeechRecognitionEventLike): string {
  const alternative = event.results[event.results.length - 1]?.[0];
  return alternative ? alternative.transcript.trim() : "";
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

export function useSpeech(onUtterance: (text: string) => void): {
  supported: boolean;
  listening: boolean;
  live: string;
  toggle: () => void;
} {
  const supported = useSyncExternalStore(
    subscribe,
    readSupported,
    serverSupported,
  );
  const [listening, setListening] = useState(false);
  /** The sentence being spoken, for showing only. Replaced whole, every time. */
  const [live, setLive] = useState("");
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  /**
   * Whether the microphone is still wanted, which is not the same question as
   * whether it is currently running.
   *
   * A session ends by itself at every pause (see `continuous` below), and the
   * answer to "start another one?" is needed inside `onend` — synchronously,
   * from a closure created several sessions ago. `listening` is state and would
   * be whatever it was when that closure was made; this is the live answer, and
   * only a press changes it.
   */
  const wanted = useRef(false);
  /**
   * The unsettled sentence on screen, so a session that ends without settling
   * it does not throw it away. Kept beside `live` rather than read from it for
   * the same reason as `wanted`: `onend` needs the current value, not the one
   * that was current when the handler was created.
   */
  const pending = useRef("");
  /**
   * The callback through a ref, so restarting recognition is not a dependency
   * of every keystroke in the textarea above it.
   *
   * Kept current in an effect rather than assigned during render, for the same
   * reason `useDismissOnOutsidePress` does it: a ref written while rendering is
   * a render with a side effect, and the lint rule says so.
   */
  const sink = useRef(onUtterance);
  useEffect(() => {
    sink.current = onUtterance;
  });

  /**
   * A finished sentence leaves the preview and goes in the field, once.
   *
   * Emptiness is dropped here rather than at each call site because there are
   * three of them — a settled result, a session that ended holding an unsettled
   * one, and the press that stops listening — and a silent session reaching the
   * textarea as ", " would be worse than useless.
   */
  const commit = useCallback((text: string) => {
    pending.current = "";
    setLive("");
    if (text) sink.current(text);
  }, []);

  const listen = useCallback(() => {
    const Recognition = ctor();
    if (!Recognition) return false;

    const rec = new Recognition();

    /**
     * Is `rec` still the instance the hook is driving?
     *
     * Every handler asks before it touches anything shared, because a stopped
     * `SpeechRecognition` is not a finished one: `stop()` with audio still
     * pending fires one last `onresult` and then `onend`, asynchronously, after
     * the call has returned. Unguarded, a retired instance's late `onend` would
     * drop the reference to a new, still-listening one and flip the button back
     * to "not listening" with the microphone open.
     *
     * Identity rather than a session counter: `recognition.current` is already
     * the single answer to "which one is live", every path that retires an
     * instance clears or replaces it, and a counter would be a second thing to
     * keep in step with it. Declared here rather than in the component body so
     * it closes over `rec` directly and cannot be captured from a stale render.
     */
    const isCurrent = () => recognition.current === rec;

    rec.lang = "sv-SE";
    /**
     * One sentence per session, and this is the structural half of the fix.
     *
     * Continuous recognition is what produced a list of results to reconcile in
     * the first place, and reconciling them is exactly what no rule could do
     * correctly across engines. A session that carries one utterance has one
     * result to read, so the ambiguity is not handled — it is absent.
     *
     * The cost is that the engine stops at every pause. That is paid in `onend`
     * by starting another session, which also makes the pause the moment a
     * sentence lands in the field. Sessions cannot restate each other's words —
     * a new one starts empty — so joining ACROSS them is sound in the way that
     * joining within one never was.
     */
    rec.continuous = false;
    // The words appear as they are said. A silent five seconds followed by a
    // paragraph reads as a hang.
    rec.interimResults = true;

    // Shown, never kept. Every event is another go at the same sentence, and
    // the field hears about it only when the session is over.
    rec.onresult = (event) => {
      if (!isCurrent()) return;
      const text = hear(event);
      pending.current = text;
      setLive(text);
    };

    rec.onend = () => {
      if (!isCurrent()) return;
      // The session ending IS the sentence ending — that is the whole reason
      // one session carries one utterance. Whatever it left on screen is what
      // the speaker watched arrive, so that is what goes in the field.
      commit(pending.current);
      if (wanted.current) {
        rec.start();
        return;
      }
      recognition.current = null;
      setListening(false);
    };

    /**
     * Silence is not a failure. `no-speech` is what a pause longer than the
     * engine's patience looks like, and `aborted` is what `stop()` looks like;
     * both are followed by `onend`, which is the single place that decides
     * whether to listen again. Anything else — a refused microphone, a dead
     * network — is the end of the dictation, and the button must say so rather
     * than sit lit above a microphone that is not running.
     */
    rec.onerror = (event) => {
      if (!isCurrent()) return;
      if (event.error === "no-speech" || event.error === "aborted") return;
      wanted.current = false;
      pending.current = "";
      recognition.current = null;
      setLive("");
      setListening(false);
    };

    recognition.current = rec;
    rec.start();
    return true;
  }, [commit]);

  // Whatever is still listening when the sheet closes must stop listening. The
  // microphone does not belong to a component that no longer exists. Nulled as
  // well as stopped, so the guard above also retires the last instance's late
  // events rather than letting them reach a sink that is gone.
  useEffect(
    () => () => {
      wanted.current = false;
      recognition.current?.stop();
      recognition.current = null;
    },
    [],
  );

  const toggle = useCallback(() => {
    const rec = recognition.current;
    if (rec) {
      // Retired before it is stopped, so its trailing `onresult` and `onend`
      // change nothing — which is also why the half-spoken sentence is
      // committed here rather than left for a handler that will not run.
      wanted.current = false;
      recognition.current = null;
      rec.stop();
      commit(pending.current);
      setListening(false);
      return;
    }

    wanted.current = true;
    if (listen()) setListening(true);
    else wanted.current = false;
  }, [commit, listen]);

  return { supported, listening, live, toggle };
}
