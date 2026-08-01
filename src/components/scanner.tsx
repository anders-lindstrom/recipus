"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UiIcon } from "./ui-icon";

/**
 * The barcode scanner.
 *
 * Chrome on Android has a native `BarcodeDetector`; Safari does not, and Safari
 * is very likely what the other person in the household is holding. So the wasm
 * decoder is loaded — but only when the native one is missing, so Android never
 * downloads a megabyte it has no use for.
 *
 * The scanner stays open and keeps scanning. Emptying a recycling bag is one
 * continuous session, not eight round trips through a modal.
 */

/**
 * What the last scan did, and how to take it back.
 *
 * Buy-mode scanning acts immediately — it adds the item and records the purchase
 * with no dialog — so the only thing standing between a mis-scan and a wrong
 * purchase is this. It belongs in the scanner rather than in a toast because the
 * scanner stays open: you work through a basket, and a confirmation that covered
 * the viewfinder or interrupted the session would defeat the point.
 */
export interface ScanOutcome {
  text: string;
  /** Absent when there is nothing to take back (an unknown code, say). */
  undo?: () => void;
}

export interface ScannerProps {
  onScan: (ean: string) => void;
  onClose: () => void;
  /** Feedback for the last scan: what happened, in Swedish. */
  lastResult?: ScanOutcome | null;
  /**
   * Stop reporting hits, without tearing the camera down.
   *
   * Set while a scan is waiting on an answer — "which vara is this?" — because
   * the session is continuous by design: the viewfinder stays live and a second
   * product drifting past would replace the question mid-sentence. The
   * per-code cooldown does not cover this; it suppresses repeats of the SAME
   * code, and the problem here is a different one.
   *
   * Deliberately not a teardown. Releasing the stream and re-acquiring it costs
   * a visible second of black and, on iOS, another permission-shaped pause —
   * for a dialog that is usually dismissed in two taps.
   */
  paused?: boolean;
}

type DetectFn = (video: HTMLVideoElement) => Promise<string[]>;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: {
      formats?: string[];
    }) => BarcodeDetectorLike;
  }
}

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];

/**
 * Pick a decoder: native when the browser has one, wasm otherwise.
 *
 * Returns null when neither is usable, which the UI turns into manual entry
 * rather than a dead end — worn and creased barcodes need that path anyway.
 */
async function createDetector(): Promise<DetectFn | null> {
  if (typeof window !== "undefined" && window.BarcodeDetector) {
    try {
      const native = new window.BarcodeDetector({ formats: FORMATS });
      return async (video) => {
        const found = await native.detect(video);
        return found.map((f) => f.rawValue);
      };
    } catch {
      // Constructed but unusable (some browsers advertise it without the
      // formats we need). Fall through to wasm.
    }
  }

  try {
    const { readBarcodes } = await import("zxing-wasm/reader");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    return async (video) => {
      if (!video.videoWidth) return [];
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const results = await readBarcodes(
        ctx.getImageData(0, 0, canvas.width, canvas.height),
        { formats: ["EAN-13", "EAN-8", "UPC-A", "UPC-E"], tryHarder: true },
      );
      return results.map((r) => r.text).filter(Boolean);
    };
  } catch {
    return null;
  }
}

export function Scanner({
  onScan,
  onClose,
  lastResult,
  paused = false,
}: ScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(true);
  // Scanning the same carton for several frames in a row must not add milk
  // four times.
  const recentRef = useRef<Map<string, number>>(new Map());

  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [needsManual, setNeedsManual] = useState(false);

  /*
   * A ref rather than a dependency, and the reason is the camera.
   *
   * `handleHit` is what the detection effect depends on, so putting `paused` in
   * its dependency list would change its identity every time a sheet opens —
   * tearing the effect down, stopping every track, and re-acquiring the stream.
   * That is a second of black and, on iOS, a second permission-shaped pause,
   * every time somebody is asked what they just scanned.
   */
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const handleHit = useCallback(
    (code: string) => {
      if (pausedRef.current) return;
      const now = Date.now();
      const seen = recentRef.current.get(code);
      if (seen && now - seen < 2500) return;
      recentRef.current.set(code, now);
      navigator.vibrate?.(20);
      onScan(code);
    },
    [onScan],
  );

  useEffect(() => {
    runningRef.current = true;
    let raf = 0;

    async function run() {
      const detect = await createDetector();
      if (!detect) {
        setNeedsManual(true);
        return;
      }

      try {
        // The rear camera, and a resolution high enough to resolve the thin
        // bars of an EAN-13 at arm's length.
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
      } catch {
        setError("Kameran kunde inte startas. Kontrollera behörigheten.");
        setNeedsManual(true);
        return;
      }

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = streamRef.current;
      await video.play().catch(() => undefined);

      let busy = false;
      const tick = async () => {
        if (!runningRef.current) return;
        // Skip a frame rather than queue work behind a slow wasm decode —
        // otherwise the backlog grows and the preview visibly stutters.
        if (!busy) {
          busy = true;
          try {
            for (const code of await detect(video)) handleHit(code);
          } catch {
            // A single bad frame is not worth tearing the session down.
          } finally {
            busy = false;
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    void run();

    return () => {
      runningRef.current = false;
      cancelAnimationFrame(raf);
      // Releasing every track matters: a camera left running drains the battery
      // and leaves the indicator light on, which reads as the app spying.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [handleHit]);

  return (
    // The scanner is the one screen that ignores the page theme, in both
    // schemes: it is a viewfinder, and anything other than black around a
    // camera feed competes with it for the eye.
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="safe-top flex flex-none items-center gap-2 px-2 py-2 text-white">
        <span className="flex-1 pl-2 text-title">Skanna streckkod</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Stäng"
          className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-white/10"
        >
          <UiIcon name="close" size={20} />
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
        />
        {!needsManual && (
          // Corner brackets rather than a full rectangle: the frame is there to
          // say "aim here", and a closed box reads as a control you can miss.
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-8 top-1/2 h-36 -translate-y-1/2"
          >
            <span className="absolute top-0 left-0 h-7 w-7 rounded-tl-lg border-t-[3px] border-l-[3px] border-white" />
            <span className="absolute top-0 right-0 h-7 w-7 rounded-tr-lg border-t-[3px] border-r-[3px] border-white" />
            <span className="absolute bottom-0 left-0 h-7 w-7 rounded-bl-lg border-b-[3px] border-l-[3px] border-white" />
            <span className="absolute right-0 bottom-0 h-7 w-7 rounded-br-lg border-r-[3px] border-b-[3px] border-white" />
          </div>
        )}
      </div>

      <div className="safe-bottom flex-none bg-black px-4 pt-4 pb-4 text-white">
        {error && (
          <p className="mb-3 flex items-start gap-2 text-body-sm text-red-300">
            <UiIcon name="warning" size={16} className="mt-0.5 flex-none" />
            {error}
          </p>
        )}

        {lastResult && (
          <div
            aria-live="polite"
            className="mb-3 flex items-center gap-2 rounded-control bg-white/10 px-3 py-2.5 text-body-sm font-semibold"
          >
            <UiIcon name="check" size={16} className="flex-none" />
            <span className="flex-1">{lastResult.text}</span>
            {lastResult.undo && (
              <button
                type="button"
                onClick={lastResult.undo}
                className="flex flex-none items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-caption font-semibold"
              >
                <UiIcon name="undo" size={13} />
                Ångra
              </button>
            )}
          </div>
        )}

        {needsManual ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const code = manual.trim();
              if (code) {
                onScan(code);
                setManual("");
              }
            }}
            className="flex gap-2"
          >
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              inputMode="numeric"
              placeholder="Skriv streckkoden"
              aria-label="Streckkod"
              className="min-w-0 flex-1 rounded-control bg-white/10 px-3 py-3 text-body text-white outline-none placeholder:text-white/50"
            />
            <button
              type="submit"
              className="flex-none rounded-control bg-brand px-5 py-3 text-body font-semibold text-on-brand"
            >
              Sök
            </button>
          </form>
        ) : (
          <p className="text-center text-body-sm text-white/70">
            Rikta kameran mot streckkoden. Skannern fortsätter tills du stänger
            den.
          </p>
        )}
      </div>
    </div>
  );
}
