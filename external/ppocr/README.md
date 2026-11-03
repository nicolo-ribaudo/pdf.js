# PaddleOCR text recognition service (OCR demo)

An example implementation of the text recognition (OCR) service interface of PDF.js, `BaseTextRecognitionService` in `web/text_recognition_service.js`, with [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv5 mobile models running in [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) (WebGPU, or WASM). It is not part of PDF.js: PDF.js only defines the interface, and embedders (e.g. Firefox) provide their own OCR engine through `BaseExternalServices.createTextRecognitionService`. Only the development viewer uses this one, for its OCR demo (see `web/genericcom.js`; `#ocrbackend=webgpu|wasm` in the URL hash chooses the backend).

## Code

- `paddle_ocr_service.js`: `PaddleOCRService`, the service. It runs the models in a module worker, created on the first `recognize` call (and recreated after a fatal error); it queues the calls, maps the worker messages to the `onProgress`, `onLinesDetected` and `onLinesRecognized` callbacks, and cancels the worker job when the `AbortSignal` is aborted. Its models are the recognition models below; `model: null` lets the worker choose them by script.
- `ocr_worker.js`: the worker. It loads the runtime and the detection model first, and each recognition model the first time a page needs it. A job detects the lines, crops them, identifies their script in automatic mode, and reads them, in reading order. The line boxes are oriented like their text: their first corner is the top-left corner of the upright text (for lines rotated by 90°, it is not the top-left corner in the image).
- `ocr_models.js`: the models, their settings, and the recognition model used for each script in automatic mode.
- `det_postprocess.js`: the pre- and post-processing of the detection model (DB): input tensor, and boxes from the probability map, in reading order.
- `rec_postprocess.js`: the pre- and post-processing of the recognition models (SVTR/CTC): input tensors, CTC decoding, right-to-left reordering, and parsing of `inference.yml`.
- `script_id.js`: identifies the script of a line (Latin, Cyrillic, CJK or Arabic) from its image, with a small classifier, and decides which recognition models a page needs.

## Models

The ONNX models are vendored here so the viewer never fetches them cross-origin, and so results are reproducible.

| Directory | Source (Hugging Face) | Revision | File | Size | sha256 |
|---|---|---|---|---|---|
| `PP-OCRv5_mobile_det` | [PaddlePaddle/PP-OCRv5_mobile_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx) | `e6f4fa85f00e168c862bc462aebca69eef9b3d3d` | `inference.onnx` | 4826518 | `a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d` |
| | | | `inference.yml` | 903 | `98069072e1b6b37d727fd9d9f11725faa46d6ea0de012f2ed26caea011c37699` |
| `en_PP-OCRv5_mobile_rec` | [PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx) | `3fafbc3b5dcf93dd72add9f48368be8a3a2cd33b` | `inference.onnx` | 7848423 | `b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f` |
| | | | `inference.yml` | 3964 | `27e91d0582f40168aa218303c76e184bc78fa7a5d105aad0cfbad8458b441067` |
| `latin_PP-OCRv5_mobile_rec` | [PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx) | `89d3a50e2c27e2e7cceeab0e944c25c807d5db4f` | `inference.onnx` | 8042023 | `7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498` |
| | | | `inference.yml` | 6817 | `0bbe984570f597af3638e50bdf2e8276f3ab26a61966096538b3b0d1849f5c84` |
| `cyrillic_PP-OCRv5_mobile_rec` | [PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx) | `2cef88145434beb8afa9dd82d77d799eb1ad7b29` | `inference.onnx` | 8048799 | `5371ee1ddaa7983cc62d0818d99e982b6804638c85e4f960d59a574094e172e5` |
| | | | `inference.yml` | 6991 | `5c76cc91fa98410178a09f498db10050d0ec1634a660053d3005ab7be581f501` |
| `PP-OCRv5_mobile_rec` | [PaddlePaddle/PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx) | `ed152b8b495f84de93cda5709d768548a9127622` | `inference.onnx` | 16534782 | `da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092` |
| | | | `inference.yml` | 148345 | `5dfeb2777f6d0db8177d8128a8acfcf6e6276dc4ac73ea3bf0dc06d6a5e85d8e` |
| `arabic_PP-OCRv5_mobile_rec` | [PaddlePaddle/arabic_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/arabic_PP-OCRv5_mobile_rec_onnx) | `14aaedcd75825982689ecf5cd64ab33ee083215a` | `inference.onnx` | 7998947 | `799113ebf267fbe742deb99eb36e8d42c9ddc5291ceacf92add41b4d52a59110` |
| | | | `inference.yml` | 6165 | `21368419e6c016c31db55d316d59e11c128e1913e6e6fe10287084710043d3a6` |

The detection model is shared by the recognition models, which the user can choose, or which are chosen by script in automatic mode (see `SCRIPT_MODELS` in `ocr_models.js`):

- `en_PP-OCRv5_mobile_rec`: English.
- `latin_PP-OCRv5_mobile_rec`: Latin-script languages, e.g. French, Italian, Spanish, German.
- `cyrillic_PP-OCRv5_mobile_rec`: Cyrillic-script languages, e.g. Russian, Ukrainian, Bulgarian, Serbian.
- `PP-OCRv5_mobile_rec`: Simplified and Traditional Chinese, Japanese, and English.
- `arabic_PP-OCRv5_mobile_rec`: Arabic.

Model formats:

- `*_det`: DB text detection (the post-processing thresholds are in `inference.yml`). Input `x: [1, 3, H, W]` (BGR, ImageNet-normalized, H and W multiples of 32); output `[1, 1, H, W]` probability map.
- `*_rec`: SVTR/CTC text recognition. Input `x: [N, 3, 48, W]` (BGR, `(x / 255 - 0.5) / 0.5`); output `[N, W / 8, C]`. The character dictionary is the `character_dict` list in `inference.yml` (plus CTC blank at index 0 and a trailing space).

The models are licensed under the Apache License 2.0, see `LICENSE`.

To re-download and verify them: `node external/ppocr/fetch_models.mjs`.
