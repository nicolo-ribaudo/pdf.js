/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Creates "scanned" (image-only) test PDFs for the OCR demo of the development
 * viewer, in `build/ocr-demo/`:
 *  - `scanned-tracemonkey.pdf`: `test/pdfs/tracemonkey.pdf`, rasterized.
 *  - `scanned-multilang.pdf`: `multilang.html` (English, Chinese, Japanese,
 *    Italian, Arabic, French, Russian), printed with Chrome and rasterized;
 *    the text of each page is saved next to it (`multilang-<lang>.txt`), as
 *    ground truth.
 *
 * Requires Ghostscript (`gs`) and Chrome (the `CHROME` environment variable,
 * or `google-chrome`), plus the fonts used by `multilang.html` (DejaVu, Noto
 * Sans CJK, Noto Kufi Arabic).
 *
 * Usage: node external/ppocr/demo/make_test_pdfs.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const ROOT = path.join(import.meta.dirname, "../../..");
const OUTPUT_DIR = path.join(ROOT, "build/ocr-demo");
const RESOLUTION = 150; // DPI of the "scans".

function rasterize(input, output) {
  execFileSync("gs", [
    "-q",
    "-sDEVICE=pdfimage24",
    `-r${RESOLUTION}`,
    "-o",
    output,
    input,
  ]);
  console.log(`Created ${path.relative(ROOT, output)}`);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

rasterize(
  path.join(ROOT, "test/pdfs/tracemonkey.pdf"),
  path.join(OUTPUT_DIR, "scanned-tracemonkey.pdf")
);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "google-chrome",
  headless: true,
});
const vectorPdf = path.join(OUTPUT_DIR, "multilang-vector.pdf");
try {
  const page = await browser.newPage();
  await page.goto(`file://${path.join(import.meta.dirname, "multilang.html")}`);
  await page.evaluateHandle("document.fonts.ready");
  const texts = await page.evaluate(() =>
    Array.from(document.querySelectorAll("section"), section => [
      section.lang,
      section.innerText.trim(),
    ])
  );
  for (const [lang, text] of texts) {
    fs.writeFileSync(path.join(OUTPUT_DIR, `multilang-${lang}.txt`), text);
  }
  await page.pdf({ path: vectorPdf, preferCSSPageSize: true });
} finally {
  await browser.close();
}
rasterize(vectorPdf, path.join(OUTPUT_DIR, "scanned-multilang.pdf"));
fs.rmSync(vectorPdf);
