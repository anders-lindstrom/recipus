import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Dictation, against a fake speech engine.
 *
 * The engine is replaced rather than driven, and it has to be: there is no
 * microphone in a test run, and the thing worth proving is not that Chrome can
 * hear Swedish — it is that what an engine SAYS becomes the right text on
 * screen. That question is exactly where every version of this feature has gone
 * wrong, and it is answerable with a scripted engine and nothing else.
 *
 * The scripts below are transcribed from what a phone actually does. A phone
 * settles the same sentence over and over at growing indices — "A", "A B",
 * "A B C" — each result the whole sentence so far rather than the next piece of
 * it. Reading that as a list of pieces and adding them up is what produced
 * "massvismassvis med gröt", so it is written out here in full rather than
 * summarised, and any future rule that sums results will fail this file.
 */

/**
 * A `SpeechRecognition` that says what the test tells it to.
 *
 * Installed before any script runs, because the hook reads `window` during the
 * render that hydrates and a later definition would be a browser that grew a
 * speech engine while the sheet was open — which the hook is explicitly built
 * to assume cannot happen.
 */
async function installFakeEngine(page: Page) {
  await page.addInitScript(() => {
    interface Result {
      transcript: string;
      isFinal: boolean;
    }

    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      running = false;

      start() {
        this.running = true;
        (window as unknown as { __speech: FakeRecognition }).__speech = this;
        (window as unknown as { __speechStarts: number }).__speechStarts =
          ((window as unknown as { __speechStarts?: number }).__speechStarts ??
            0) + 1;
      }

      stop() {
        this.running = false;
        this.onend?.();
      }

      /** One event, carrying every result of the session so far. */
      say(results: Result[]) {
        this.onresult?.({
          results: results.map((r) =>
            Object.assign([{ transcript: r.transcript }], {
              isFinal: r.isFinal,
            }),
          ),
        });
      }
    }

    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
      FakeRecognition;
  });
}

/** Drive the engine the sheet is currently listening to. */
async function speak(
  page: Page,
  results: { transcript: string; isFinal: boolean }[],
) {
  await page.evaluate((r) => {
    (
      window as unknown as { __speech: { say: (x: unknown) => void } }
    ).__speech.say(r);
  }, results);
}

/** The session ends by itself, which is what a pause looks like. */
async function pause(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __speech: { onend: (() => void) | null } }).__speech
      .onend?.();
  });
}

async function openSheet(page: Page) {
  await page.getByRole("button", { name: "Lägg till flera med AI" }).click();
  return page.getByRole("dialog");
}

test("shows the sentence building up and keeps it only once", async ({
  freshPage: page,
}) => {
  await installFakeEngine(page);
  await page.reload();

  const dialog = await openSheet(page);
  await dialog.getByRole("button", { name: "Säg vad ni behöver" }).click();

  const preview = dialog.locator("p[aria-live='polite']");
  const field = dialog.getByRole("textbox", { name: /skriv och klistra in/i });

  // The phone restates the whole sentence at a new index every time. Each of
  // these is one event carrying every result of the session so far.
  await speak(page, [{ transcript: "A", isFinal: true }]);
  await expect(preview).toHaveText("A");

  await speak(page, [
    { transcript: "A", isFinal: true },
    { transcript: "A B", isFinal: true },
  ]);
  await expect(preview).toHaveText("A B");

  await speak(page, [
    { transcript: "A", isFinal: true },
    { transcript: "A B", isFinal: true },
    { transcript: "A B C", isFinal: true },
  ]);
  await expect(preview).toHaveText("A B C");

  await speak(page, [
    { transcript: "A", isFinal: true },
    { transcript: "A B", isFinal: true },
    { transcript: "A B C", isFinal: true },
    { transcript: "A B C D", isFinal: true },
  ]);
  await expect(preview).toHaveText("A B C D");

  await speak(page, [
    { transcript: "A", isFinal: true },
    { transcript: "A B", isFinal: true },
    { transcript: "A B C", isFinal: true },
    { transcript: "A B C D", isFinal: true },
    { transcript: "A B C D E", isFinal: true },
  ]);
  await expect(preview).toHaveText("A B C D E");

  // The whole point: five restatements of one sentence are one sentence.
  await pause(page);
  await expect(field).toHaveValue("A B C D E");
});

test("keeps listening through a pause and joins the sentences", async ({
  freshPage: page,
}) => {
  await installFakeEngine(page);
  await page.reload();

  const dialog = await openSheet(page);
  const mic = dialog.getByRole("button", { name: "Säg vad ni behöver" });
  await mic.click();

  const field = dialog.getByRole("textbox", { name: /skriv och klistra in/i });

  await speak(page, [{ transcript: "massvis med gröt", isFinal: true }]);
  await pause(page);
  await expect(field).toHaveValue("massvis med gröt");

  // Still lit: a pause ends a session, not the dictation.
  await expect(
    dialog.getByRole("button", { name: /Lyssnar/ }),
  ).toBeVisible();

  // The next session starts empty, so joining across the two is sound.
  await speak(page, [{ transcript: "två liter mjölk", isFinal: true }]);
  await pause(page);
  await expect(field).toHaveValue("massvis med gröt, två liter mjölk");
});

test("keeps nothing until the sentence is over", async ({
  freshPage: page,
}) => {
  await installFakeEngine(page);
  await page.reload();

  const dialog = await openSheet(page);
  await dialog.getByRole("button", { name: "Säg vad ni behöver" }).click();

  const preview = dialog.locator("p[aria-live='polite']");
  const field = dialog.getByRole("textbox", { name: /skriv och klistra in/i });

  // A guess sharpening itself replaces its own earlier form, and stays out of
  // the field while it can still change.
  await speak(page, [{ transcript: "två", isFinal: false }]);
  await expect(preview).toHaveText("två");
  await speak(page, [{ transcript: "två liter", isFinal: false }]);
  await expect(preview).toHaveText("två liter");
  await expect(field).toHaveValue("");

  /*
   * A result calling itself final changes nothing on its own, and that is the
   * point rather than an oversight: the phone in the first test marks every
   * restatement final, so trusting the flag would file five copies of one
   * sentence. The sentence is over when the session is.
   */
  await speak(page, [{ transcript: "två liter mjölk", isFinal: true }]);
  await expect(preview).toHaveText("två liter mjölk");
  await expect(field).toHaveValue("");

  await pause(page);
  await expect(field).toHaveValue("två liter mjölk");
  await expect(preview).toHaveText("…");
});

test("stops when told, keeping the half-spoken sentence", async ({
  freshPage: page,
}) => {
  await installFakeEngine(page);
  await page.reload();

  const dialog = await openSheet(page);
  await dialog.getByRole("button", { name: "Säg vad ni behöver" }).click();

  const field = dialog.getByRole("textbox", { name: /skriv och klistra in/i });

  // Never settled — the speaker pressed stop mid-sentence. The words they
  // watched arrive must not vanish with the session.
  await speak(page, [{ transcript: "bröd och ägg", isFinal: false }]);
  await dialog.getByRole("button", { name: /Lyssnar/ }).click();

  await expect(field).toHaveValue("bröd och ägg");
  await expect(
    dialog.getByRole("button", { name: "Säg vad ni behöver" }),
  ).toBeVisible();
});
