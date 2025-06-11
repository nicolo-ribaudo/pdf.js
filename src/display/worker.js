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

let mainHandler, workerHandler;

class RendererMessageHandler {
  static {
    this.initializeFromPort(self);
  }

  static initializeFromPort(port) {
    mainHandler = new MessageHandler("renderer", "main", port);
    mainHandler.send("ready", null);

    mainHandler.on("Ready", function () {
      // DO NOTHING
    });

    mainHandler.on("configure", ({ channelPort }) => {
      workerHandler = new MessageHandler(
        "renderer-channel",
        "worker-channel",
        channelPort
      );
      workerHandler.on("commonobj", ([id, type, data]) => {
        handleCommonObj(id, type, data, workerHandler);
      });
      workerHandler.on("obj", ([id, pageIndex, type, data]) => {
        handleObj(pageIndex, id, type, data);
      });
    });

    mainHandler.on(
      "init",
      ({
        pageIndex,
        canvas,
        drawingParams,
        map,
        colors,
        enableHWA,
        taskID,
      }) => {
        assert(!tasks.has(taskID), "Task already initialized");
        const ctx = canvas.getContext("2d");
        let pageObjs = objs.get(pageIndex);
        if (!pageObjs) {
          pageObjs = new PDFObjects();
          objs.set(pageIndex, pageObjs);
        }
        const gfx = new CanvasGraphics(
          ctx,
          commonObjs,
          pageObjs,
          new OffscreenCanvasFactory({ enableHWA }),
          null,
          {},
          map,
          colors
        );
        gfx.beginDrawing(drawingParams);
        tasks.set(taskID, new Task(canvas, gfx));
      }
    );
    mainHandler.on(
      "render",
      async ({ operatorList, operatorListIdx, taskID }) => {
        console.log("RENDER PAGE", operatorList, operatorListIdx);
        const task = tasks.get(taskID);
        assert(task !== undefined, "Task not initialized");
        const { canvas, gfx } = task;
        const fOperatorListIdx = gfx.executeOperatorList(
          operatorList,
          operatorListIdx,
          () => continueFn(taskID)
        );
        const bitmap = await canvas.transferToImageBitmap();
        return [fOperatorListIdx, bitmap];
      }
    );
    mainHandler.on("end", ({ taskID }) => {
      const task = tasks.get(taskID);
      assert(task !== undefined, "Task not initialized");
      task.gfx.endDrawing();
    });
  }
}

function handleCommonObj(id, type, exportedData, handler) {
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
        .catch(() => handler.sendWithPromise("FontFallback", { id }))
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
      throw new Error(
        `Got unknown object type ${type} id ${id} for page ${pageIndex} data ${JSON.stringify(exportedData)}`
      );
  }
}

class Task {
  constructor(canvas, gfx) {
    this.canvas = canvas;
    this.gfx = gfx;
  }
}

const tasks = new Map();

function continueFn(taskID) {
  mainHandler.send("continue", { taskID });
}
