#!/usr/bin/env node

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
 * Downloads the PaddleOCR (PP-OCRv5) ONNX models used by the OCR demo of the
 * development viewer, at pinned Hugging Face revisions, and verifies them.
 *
 * Usage: node external/ppocr/fetch_models.mjs
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HF_BASE_URL = "https://huggingface.co";

const MODELS = [
  {
    dir: "PP-OCRv5_mobile_det",
    repo: "PaddlePaddle/PP-OCRv5_mobile_det_onnx",
    revision: "e6f4fa85f00e168c862bc462aebca69eef9b3d3d",
    files: {
      "inference.onnx":
        "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
      "inference.yml":
        "98069072e1b6b37d727fd9d9f11725faa46d6ea0de012f2ed26caea011c37699",
    },
  },
  {
    dir: "en_PP-OCRv5_mobile_rec",
    repo: "PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx",
    revision: "3fafbc3b5dcf93dd72add9f48368be8a3a2cd33b",
    files: {
      "inference.onnx":
        "b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f",
      "inference.yml":
        "27e91d0582f40168aa218303c76e184bc78fa7a5d105aad0cfbad8458b441067",
    },
  },
  {
    dir: "latin_PP-OCRv5_mobile_rec",
    repo: "PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx",
    revision: "89d3a50e2c27e2e7cceeab0e944c25c807d5db4f",
    files: {
      "inference.onnx":
        "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498",
      "inference.yml":
        "0bbe984570f597af3638e50bdf2e8276f3ab26a61966096538b3b0d1849f5c84",
    },
  },
  {
    dir: "cyrillic_PP-OCRv5_mobile_rec",
    repo: "PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx",
    revision: "2cef88145434beb8afa9dd82d77d799eb1ad7b29",
    files: {
      "inference.onnx":
        "5371ee1ddaa7983cc62d0818d99e982b6804638c85e4f960d59a574094e172e5",
      "inference.yml":
        "5c76cc91fa98410178a09f498db10050d0ec1634a660053d3005ab7be581f501",
    },
  },
  {
    dir: "PP-OCRv5_mobile_rec",
    repo: "PaddlePaddle/PP-OCRv5_mobile_rec_onnx",
    revision: "ed152b8b495f84de93cda5709d768548a9127622",
    files: {
      "inference.onnx":
        "da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092",
      "inference.yml":
        "5dfeb2777f6d0db8177d8128a8acfcf6e6276dc4ac73ea3bf0dc06d6a5e85d8e",
    },
  },
  {
    dir: "arabic_PP-OCRv5_mobile_rec",
    repo: "PaddlePaddle/arabic_PP-OCRv5_mobile_rec_onnx",
    revision: "14aaedcd75825982689ecf5cd64ab33ee083215a",
    files: {
      "inference.onnx":
        "799113ebf267fbe742deb99eb36e8d42c9ddc5291ceacf92add41b4d52a59110",
      "inference.yml":
        "21368419e6c016c31db55d316d59e11c128e1913e6e6fe10287084710043d3a6",
    },
  },
];

const outputDir = import.meta.dirname;
let failed = false;

for (const { dir, repo, revision, files } of MODELS) {
  fs.mkdirSync(path.join(outputDir, dir), { recursive: true });

  for (const [name, expectedHash] of Object.entries(files)) {
    const url = `${HF_BASE_URL}/${repo}/resolve/${revision}/${name}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unable to fetch ${url}: ${response.status}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    const hash = createHash("sha256").update(data).digest("hex");

    if (hash !== expectedHash) {
      console.error(`${dir}/${name}: sha256 mismatch (got ${hash})`);
      failed = true;
      continue;
    }
    fs.writeFileSync(path.join(outputDir, dir, name), data);
    console.log(`${dir}/${name}: ${data.length} bytes, sha256 ${hash}`);
  }
}

if (failed) {
  process.exit(1);
}
