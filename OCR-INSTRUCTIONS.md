# OCR demo

This branch adds text recognition (OCR) of scanned pages to the PDF.js viewer: each page gets an **OCR** button, and the recognized text is added to the page as a selectable, copyable text layer. For demo purposes the text is slightly visible, so you can see OCR at work: dashed boxes first, around each detected line, then translucent blue text fading in as lines are recognized.

The OCR engine is not part of PDF.js. PDF.js defines an interface, `TextRecognitionService`, that embedders implement, e.g. Firefox with its own models. For this demo, the development viewer implements it with [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv5 mobile models running in the browser with ONNX Runtime Web, on WebGPU or WebAssembly. Everything runs locally, and all the files come from the same origin as the viewer.

## Quick start

```sh
npm install

# Optional: create the test PDFs in build/ocr-demo/ (requires Ghostscript,
# Chrome, and the DejaVu, Noto Sans CJK and Noto Kufi Arabic fonts).
CHROME=/usr/bin/google-chrome node external/ppocr/demo/make_test_pdfs.mjs

# Start the development server. --coi enables cross-origin isolation, which
# lets WebAssembly use multiple threads (about 3x faster without WebGPU).
npx gulp server --coi
```

Then open:

- a scanned paper (14 English pages, two columns): <http://localhost:8888/web/viewer.html?file=/build/ocr-demo/scanned-tracemonkey.pdf>
- one page per language (English, Chinese, Japanese, Italian, Arabic, French, Russian): <http://localhost:8888/web/viewer.html?file=/build/ocr-demo/scanned-multilang.pdf>
- any other PDF: <http://localhost:8888/web/viewer.html>, then open a file. Scanned PDFs work best, but OCR works on any page.

OCR is only available in the development viewer (`gulp server`); the builds (`gulp generic`, …) are not affected.

### WebGPU

OCR uses WebGPU when the browser exposes it, and WebAssembly otherwise:

| | WebGPU | WebAssembly, `--coi` (4 threads) | WebAssembly, no `--coi` |
|---|---|---|---|
| A page of the paper | ~1.3 s (Chrome) to ~3 s (Firefox) | ~4–5 s | ~13 s |

- **Firefox**: Nightly has WebGPU enabled; on Linux, other channels need `dom.webgpu.enabled` set to `true` in `about:config`.
- **Chrome on Linux**: start it with `--enable-unsafe-webgpu --enable-features=Vulkan`.

The status shown at the end of each page says which one was used.

## Using it

- **One page**: click **OCR** at the top right of the page. The status next to it shows the progress: loading the engine and models (only the first time), detecting the lines, identifying the language (in Automatic mode), recognizing the lines. At the end it shows the number of lines, the time, the backend and the model(s) used; hover it for a timing breakdown.
  - While a page is being processed, the button becomes **Cancel**; once it's done, **Clear** removes the recognized text.
- **Choosing the model**: the **▾** next to **OCR** opens the list of models. **Automatic**, the default, identifies the script of the page (Latin, Cyrillic, Chinese & Japanese, Arabic) and loads only the model(s) it needs; a page mixing scripts uses one model per script. You can also pick a model explicitly:
  - PP-OCRv5 English (also used for Latin-script pages in Automatic mode)
  - PP-OCRv5 Latin (French, German, Spanish, Italian, Portuguese, …)
  - PP-OCRv5 Cyrillic (Russian, Ukrainian, Bulgarian, Serbian, …)
  - PP-OCRv5 Chinese & Japanese
  - PP-OCRv5 Arabic (Arabic, Persian, Urdu, …)
- **The whole document**: the OCR button in the main toolbar, left of the annotation tools, recognizes every page that isn't done yet, in order, including pages you haven't scrolled to. It shows the overall progress, becomes **Cancel all** while running, and shows a summary at the end.
- **The text**: select and copy it as usual. Lines that the engine isn't confident about (score below 0.5) are not added; their boxes stay orange. The text layer survives zooming, rotating and scrolling away.

### URL options

Add them after `#` in the viewer URL, separated by `&`:

- `ocrmodel=auto|<id>`: the initially selected model, e.g. `ocrmodel=PP-OCRv5_mobile_cyrillic`. The ids are listed in `external/ppocr/ocr_models.js`.
- `ocrbackend=auto|webgpu|wasm`: force a backend (PaddleOCR demo only).

For example: <http://localhost:8888/web/viewer.html?file=/build/ocr-demo/scanned-multilang.pdf#ocrmodel=auto&ocrbackend=wasm>

## What to expect

On the test PDFs:

- **Accuracy**: about 96% of the words of the scanned paper (98.7% on its plain text pages), and 94–100% of the characters on each page of the multilingual PDF with the matching model; Arabic is the weakest (about 94%).
- **Compared to Tesseract** (tesseract.js 7): more accurate on English, Chinese and Japanese, and it doesn't skip text next to figures; Tesseract is smaller to download and covers many more languages.
- **Download**: the first OCR loads ONNX Runtime (about 17–27 MB, much less with compression) and the text detection model (4.8 MB); each recognition model is 8–16.5 MB, loaded the first time it's needed.

Known limitations:

- A single line in another script (e.g. one Arabic line in an English page) doesn't trigger loading another model; it takes at least two.
- On pages with Cyrillic, Latin words are read by the Cyrillic model, and can come out with look-alike Cyrillic letters ("Firefох"): they look right, but searching for them doesn't work.
- In Automatic mode, Latin-script pages are read with the English model, which loses some accents of other languages; pick "PP-OCRv5 Latin" for French, Italian, etc.
- Pages are rendered for OCR as they are displayed: OCR a page rotated by 90° and the text is read sideways.
- Recognized text isn't searchable with the find bar yet.

## How it works

```
PDF.js viewer (web/)                                  Embedder (here: external/ppocr/)
──────────────────────────────────                    ─────────────────────────────────
web/ocr/: OCR buttons, model menu, status,            PaddleOCRService
  text layer of the recognized lines                    └─ module worker
     │                                                       ├─ ONNX Runtime Web (WebGPU / WASM)
     │ renders the page (2000 px), then                      ├─ text detection (DBNet)
     │ service.recognize(image, …)  ────────────────────►    ├─ script identification
     │                                                       └─ text recognition (one model per script)
     │ ◄── progress, detected lines, recognized lines ───
```

- `web/text_recognition_service.js` defines the interface between PDF.js and the OCR engine, `BaseTextRecognitionService`:
  - `models`: the models (or languages) that the user can choose, and `supportsAutomaticModel`.
  - `recognize(image, { model, signal, onProgress, onLinesDetected, onLinesRecognized })`: takes an `ImageBitmap` of the page and resolves with its lines of text, each with its quadrilateral in the image, its text, its direction and a confidence; the callbacks stream the progress and the lines as they are recognized.
- `web/external_services.js`: embedders return their service from `createTextRecognitionService()`; it returns `null` by default, which disables OCR. `web/genericcom.js` returns the PaddleOCR service in the development viewer.
- `web/ocr/`: the OCR user interface. It only depends on the interface: it renders pages, calls the service, and turns the recognized lines into a text layer (`OCRPageLayer`, built on `TextLayerBuilder`), kept in a dedicated layer of each page (`PDFPageView.addOCRLayer`).
- `external/ppocr/`: the PaddleOCR implementation, i.e. what an embedder would provide: `paddle_ocr_service.js`, the worker running the models, the pre- and post-processing of the models, the script identification, and the models themselves. See its `README.md`.

To use another engine, implement `BaseTextRecognitionService` and return it from `createTextRecognitionService()`:

```js
class MyOCRService extends BaseTextRecognitionService {
  get models() {
    return [{ id: "en", name: "English" }];
  }

  async recognize(image, { model, signal, onProgress, onLinesRecognized }) {
    const lines = await myEngine.read(image, { language: model, signal });
    image.close();
    onLinesRecognized?.(lines);
    return { lines, models: ["English"], engine: "MyEngine" };
  }
}
```

### The models

The PaddleOCR models are committed in `external/ppocr/`, pinned to a revision of the official PaddlePaddle repositories on Hugging Face, with their checksums (Apache-2.0). To download them again and check them: `node external/ppocr/fetch_models.mjs`.

## Troubleshooting

- **No OCR button**: make sure you're using the development viewer (`npx gulp server`, `/web/viewer.html`), and look at the console.
- **Slow (10 s or more per page)**: WebGPU isn't available and WebAssembly runs on one thread. Enable WebGPU (see above), or restart the server with `--coi`.
- **"WebGPU is not available … using WASM"** in the console: the browser has no WebGPU adapter; see above.
- **Wrong model in Automatic mode**: check that "Automatic" is selected in the ▾ menu; a model chosen explicitly applies to all the pages until you change it or reload.
