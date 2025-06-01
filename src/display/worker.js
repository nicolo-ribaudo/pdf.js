import { assert, warn } from "../shared/util.js";
import { FontFaceObject, FontLoader } from "./font_loader.js";
import { CanvasGraphics } from "./canvas.js";
import { MessageHandler } from "../shared/message_handler.js";
import { OffscreenCanvasFactory } from "./canvas_factory.js";
import { PDFObjects } from "./display_utils.js";

const commonObjs = new PDFObjects();
const objs = new Map();

const fontLoader = new FontLoader({
  ownerDocument: self,
});

class RendererMessageHandler {
  static {
    this.initializeFromPort(self);
  }

  static initializeFromPort(port) {
    const mainHandler = new MessageHandler("renderer", "main", port);
    let workerHandler;

    function setupWorkerHandler() {
      workerHandler.on("commonobj", ({ id, type, exportedData }) => {
        console.log("DIRECTLY GOT A COMMON OBJ", id, type, exportedData);
        handleCommonObj(id, type, exportedData);
      });
      workerHandler.on("obj", ({ pageIndex, id, type, exportedData }) => {
        console.log("DIRECTLY GOT AN OBJ", pageIndex, id, type, exportedData);
        handleObj(pageIndex, id, type, exportedData);
      });
      workerHandler.send("SETUP", null);
      workerHandler.on("SETUP", () => console.log("SETUP DONE"));
      workerHandler.send("Ready", null);
      workerHandler.on("Ready", function () {
        console.log("Renderer is ready (FROM WORKER)");
      });
    }

    mainHandler.on("Ready", ({ port: channelPort }) => {
      workerHandler = new MessageHandler("renderer", "worker", channelPort);
      setupWorkerHandler();
    });
  }
}

function handleCommonObj(id, type, exportedData) {
  if (commonObjs.has(id)) {
    return;
  }

  switch (type) {
    case "Font":
      if ("error" in exportedData) {
        const exportedError = exportedData.error;
        warn(`Error during font loading: ${exportedError}`);
        commonObjs.resolve(id, exportedError);
        break;
      }

      const inspectFont = null;
      // this._params.pdfBug && globalThis.FontInspector?.enabled
      //   ? (font, url) => globalThis.FontInspector.fontAdded(font, url)
      // : null;
      const font = new FontFaceObject(exportedData, inspectFont);

      fontLoader
        .bind(font)
        .catch(() => self.postMessage("FontFallback", { id }))
        .finally(() => {
          if (!font.fontExtraProperties && font.data) {
            // Immediately release the `font.data` property once the font
            // has been attached to the DOM, since it's no longer needed,
            // rather than waiting for a `PDFDocumentProxy.cleanup` call.
            // Since `font.data` could be very large, e.g. in some cases
            // multiple megabytes, this will help reduce memory usage.
            font.data = null;
          }
          commonObjs.resolve(id, font);
        });
      break;
    case "CopyLocalImage":
      const { imageRef } = exportedData;
      assert(imageRef, "The imageRef must be defined.");

      for (const pageObjs of objs.values()) {
        for (const [, data] of pageObjs) {
          if (data?.ref !== imageRef) {
            continue;
          }
          if (!data.dataLen) {
            return;
          }
          commonObjs.resolve(id, structuredClone(data));
          return;
        }
      }
      break;
    case "FontPath":
    case "Image":
    case "Pattern":
      commonObjs.resolve(id, exportedData);
      break;
    default:
      throw new Error(`Got unknown common object type ${type}`);
  }

  // return null;
}

function handleObj(pageIndex, id, type, exportedData) {
  let pageObjs = objs.get(pageIndex);
  if (!pageObjs) {
    pageObjs = new PDFObjects();
    objs.set(pageIndex, pageObjs);
  }

  if (pageObjs.has(id)) {
    return;
  }

  switch (type) {
    case "Image":
    case "Pattern":
      pageObjs.resolve(id, exportedData);
      break;
    default:
      throw new Error(`Got unknown object type ${type}`);
  }
}

class Page {
  constructor(canvas, gfx) {
    this.canvas = canvas;
    this.gfx = gfx;
  }
}

const pages = new Map();

// self.onmessage = async function (event) {
//   console.log("WORKER EVENT", event.data);
//   const { type, pageIndex, id, objType, exportedData } = event.data;
//   const page = pages.get(pageIndex);
//   console.log("page", page);
//   switch (type) {
//     case "init":
//       assert(page === undefined, "Page already initialized");
//       const {
//         canvas,
//         drawingParams: { transform, viewport, background, transparency },
//         map,
//         colors,
//         enableHWA,
//       } = event.data;
//       const ctx = canvas.getContext("2d");
//       let pageObjs = objs.get(pageIndex);
//       if (!pageObjs) {
//         pageObjs = new PDFObjects();
//         objs.set(pageIndex, pageObjs);
//       }
//       const gfx = new CanvasGraphics(
//         ctx,
//         commonObjs,
//         pageObjs,
//         new OffscreenCanvasFactory({ enableHWA }),
//         null,
//         { isVisible },
//         map,
//         colors
//       );
//       gfx.beginDrawing({
//         transform,
//         viewport,
//         transparency,
//         background,
//       });
//       pages.set(pageIndex, new Page(canvas, gfx));
//       break;
//     case "render":
//       assert(page !== undefined, "Page not initialized");
//       const { canvas: rCanvas, gfx: rGfx } = page;
//       const { operatorList, operatorListIdx, stepper } = event.data;
//       const fOperatorListIdx = rGfx.executeOperatorList(
//         operatorList,
//         operatorListIdx,
//         continueFn,
//         stepper
//       );
//       const bitmap = await rCanvas.transferToImageBitmap();
//       console.log("bitmap", bitmap);
//       self.postMessage({ type: "renderComplete", bitmap, fOperatorListIdx }, [
//         bitmap,
//       ]);
//       break;
//     case "end":
//       assert(page !== undefined, "Page not initialized");
//       const { gfx: eGfx } = page;
//       eGfx.endDrawing();
//       break;
//   }
// };

// TODO: this is a semi hack that blocks the worker for this operation. Ideally
// we should use a promise and resolve it when the main thread sends the
// isVisible message back. This would allow us to use the worker for other
// operations while waiting for the isVisible message to be sent back.
function isVisible(group) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  signal[0] = 0;
  self.postMessage({
    signal,
    type: "isVisible",
    group,
  });
  Atomics.wait(signal, 0, 0);
  const visible = signal[0] === 1;
  // console.log("isVisible", group, visible);
  return visible;
}

function continueFn() {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  signal[0] = 0;
  self.postMessage({
    signal,
    type: "continue",
  });
  Atomics.wait(signal, 0, 0);
}
