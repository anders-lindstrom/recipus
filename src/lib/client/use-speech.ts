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

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
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
  // microphone does not belong to a component that no longer exists.
  useEffect(() => () => recognition.current?.stop(), []);

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
    rec.lang = "sv-SE";
    rec.continuous = true;
    // The words appear as they are said. A silent five seconds followed by a
    // paragraph reads as a hang.
    rec.interimResults = true;
    rec.onresult = (event) => {
      let heard = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.[0]) heard += result[0].transcript;
      }
      if (heard.trim()) sink.current(heard.trim());
    };
    rec.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    rec.onerror = () => {
      recognition.current = null;
      setListening(false);
    };

    recognition.current = rec;
    rec.start();
    setListening(true);
  }, []);

  return { supported, listening, toggle };
}
