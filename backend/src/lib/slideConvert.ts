import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Slide deck → one PNG per slide, for HR trainings.
// PowerPoint/OpenDocument decks go through LibreOffice (→ PDF), then poppler's
// pdftoppm renders each page. Both binaries are installed in the production
// image; locally they are optional (SOFFICE_PATH / PDFTOPPM_PATH override).
// ---------------------------------------------------------------------------

export const SLIDE_DECK_EXTENSIONS = new Set(["pptx", "ppt", "odp", "pdf"]);
export const MAX_SLIDES = 300;
/** Rendered slide width in pixels (height follows the deck's aspect ratio). */
const SLIDE_WIDTH = 1600;
const CONVERT_TIMEOUT_MS = 180_000;

export class SlideConversionError extends Error {
  constructor(
    message: string,
    /** True when the converter isn't installed on this server. */
    readonly unavailable = false,
  ) {
    super(message);
    this.name = "SlideConversionError";
  }
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, timeout: CONVERT_TIMEOUT_MS, windowsHide: true },
      (err) => {
        if (!err) {
          resolve();
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(
            new SlideConversionError(
              "Slide conversion isn't available on this server",
              true,
            ),
          );
          return;
        }
        reject(
          new SlideConversionError(
            `Couldn't convert the slides (${path.basename(command)} failed)`,
          ),
        );
      },
    );
  });
}

// One conversion at a time: LibreOffice is memory-hungry.
let queue: Promise<unknown> = Promise.resolve();

/** Converts a deck (pptx/ppt/odp/pdf) to PNG buffers, one per slide, in order. */
export function convertDeckToSlides(
  buffer: Buffer,
  extension: string,
): Promise<Buffer[]> {
  const job = queue.then(() => convert(buffer, extension));
  queue = job.catch(() => undefined);
  return job;
}

async function convert(buffer: Buffer, extension: string): Promise<Buffer[]> {
  const ext = extension.toLowerCase();
  if (!SLIDE_DECK_EXTENSIONS.has(ext)) {
    throw new SlideConversionError(
      "Upload a PowerPoint (.pptx, .ppt), OpenDocument (.odp) or PDF file",
    );
  }
  const dir = await mkdtemp(path.join(tmpdir(), "deck-"));
  try {
    const input = path.join(dir, `deck.${ext}`);
    await writeFile(input, buffer);

    let pdf = input;
    if (ext !== "pdf") {
      const soffice = process.env.SOFFICE_PATH?.trim() || "soffice";
      const profile = `file://${path.join(dir, "lo-profile").replace(/\\/g, "/")}`;
      await run(
        soffice,
        [
          `-env:UserInstallation=${profile}`,
          "--headless",
          "--norestore",
          "--convert-to",
          "pdf",
          "--outdir",
          dir,
          input,
        ],
        dir,
      );
      pdf = path.join(dir, "deck.pdf");
    }

    const pdftoppm = process.env.PDFTOPPM_PATH?.trim() || "pdftoppm";
    await run(
      pdftoppm,
      [
        "-png",
        "-scale-to-x",
        String(SLIDE_WIDTH),
        "-scale-to-y",
        "-1",
        pdf,
        path.join(dir, "slide"),
      ],
      dir,
    );

    // pdftoppm names pages slide-1.png … or slide-01.png depending on the count.
    const pages = (await readdir(dir))
      .map((name) => ({ name, match: /^slide-(\d+)\.png$/.exec(name) }))
      .filter(
        (entry): entry is { name: string; match: RegExpExecArray } =>
          entry.match !== null,
      )
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
    if (pages.length === 0)
      throw new SlideConversionError("The file has no slides");
    if (pages.length > MAX_SLIDES)
      throw new SlideConversionError(
        `Decks are limited to ${MAX_SLIDES} slides`,
      );
    return await Promise.all(
      pages.map((page) => readFile(path.join(dir, page.name))),
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
