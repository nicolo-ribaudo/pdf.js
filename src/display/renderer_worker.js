import { assert, warn } from "../shared/util.js";
import { FontFaceObject, FontLoader } from "./font_loader.js";
import { CanvasGraphics } from "./canvas.js";
import { DOMFilterFactory } from "./filter_factory.js";
import { MessageHandler } from "../shared/message_handler.js";
import { OffscreenCanvasFactory } from "./canvas_factory.js";
import { PDFObjects } from "./display_utils.js";

class RendererMessageHandler {
  static #commonObjs = new PDFObjects();

  static #objs = new Map();

  static #tasks = new Map();

  static #fontLoader = new FontLoader({
    ownerDocument: self,
  });

  static #canvasFactory;

  static #filterFactory;

  static {
    this.initializeFromPort(self);
  }

  static pageObjs(pageIndex) {
    let pageObjs = this.#objs.get(pageIndex);
    if (!pageObjs) {
      pageObjs = new PDFObjects();
      this.#objs.set(pageIndex, pageObjs);
    }
    return pageObjs;
  }

  static initializeFromPort(port) {
    let terminated = false;
    let mainHandler = new MessageHandler("renderer", "main", port);
    mainHandler.send("ready", null);
    mainHandler.on("Ready", function () {
      // DO NOTHING
    });

    mainHandler.on("configure", ({ channelPort, enableHWA }) => {
      const workerHandler = new MessageHandler(
        "renderer-channel",
        "worker-channel",
        channelPort
      );
      this.#canvasFactory = new OffscreenCanvasFactory({
        enableHWA,
      });
      this.#filterFactory = new DOMFilterFactory({});
      workerHandler.on("commonobj", ([id, type, data]) => {
        if (terminated) {
          throw new Error("Renderer worker has been terminated.");
        }
        this.handleCommonObj(id, type, data, workerHandler, this.#commonObjs);
      });
      workerHandler.on("obj", ([id, pageIndex, type, data]) => {
        if (terminated) {
          throw new Error("Renderer worker has been terminated.");
        }
        this.handleObj(pageIndex, id, type, data);
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
        assert(!this.#tasks.has(taskID), "Task already initialized");
        const ctx = canvas.getContext("2d");
        const pageObjs = this.pageObjs(pageIndex);
        const gfx = new CanvasGraphics(
          ctx,
          this.#commonObjs,
          pageObjs,
          this.#canvasFactory,
          this.#filterFactory,
          {},
          map,
          colors
        );
        gfx.beginDrawing(drawingParams);
        this.#tasks.set(taskID, { canvas, gfx });
      }
    );
    mainHandler.on(
      "render",
      async ({ operatorList, operatorListIdx, taskID }) => {
        if (terminated) {
          throw new Error("Renderer worker has been terminated.");
        }
        const task = this.#tasks.get(taskID);
        assert(task !== undefined, "Task not initialized");
        // const { gfx } = task;
        const fOperatorListIdx = task.gfx.executeOperatorList(
          operatorList,
          operatorListIdx,
          () => mainHandler.send("continue", { taskID })
        );
        // const bitmap = await canvas.transferToImageBitmap();
        // return [fOperatorListIdx, bitmap];
        return fOperatorListIdx;
      }
    );
    mainHandler.on("end", ({ taskID }) => {
      const task = this.#tasks.get(taskID);
      assert(task !== undefined, "Task not initialized");
      task.gfx.endDrawing();
    });
    mainHandler.on("Terminate", async () => {
      terminated = true;
      this.#commonObjs.clear();
      for (const pageObjs of this.#objs.values()) {
        pageObjs.clear();
      }
      this.#objs.clear();
      this.#tasks.clear();
      this.#fontLoader.clear();
      mainHandler.destroy();
      mainHandler = null;
    });
  }

  static handleCommonObj(id, type, exportedData, handler) {
    if (this.#commonObjs.has(id)) {
      return null;
    }

    switch (type) {
      case "Font":
        if ("error" in exportedData) {
          const exportedError = exportedData.error;
          warn(`Error during font loading: ${exportedError}`);
          this.#commonObjs.resolve(id, exportedError);
          break;
        }

        // TODO: Make FontInspector work again.
        const inspectFont = null;
        // this._params.pdfBug && globalThis.FontInspector?.enabled
        //   ? (font, url) => globalThis.FontInspector.fontAdded(font, url)
        // : null;
        const font = new FontFaceObject(exportedData, inspectFont);

        this.#fontLoader
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
            this.#commonObjs.resolve(id, font);
          });
        break;
      case "CopyLocalImage":
        const { imageRef } = exportedData;
        assert(imageRef, "The imageRef must be defined.");

        for (const pageObjs of this.#objs.values()) {
          for (const [, data] of pageObjs) {
            if (data?.ref !== imageRef) {
              continue;
            }
            if (!data.dataLen) {
              return null;
            }
            this.#commonObjs.resolve(id, structuredClone(data));
            return data.dataLen;
          }
        }
        break;
      case "FontPath":
      case "Image":
      case "Pattern":
        this.#commonObjs.resolve(id, exportedData);
        break;
      default:
        throw new Error(`Got unknown common object type ${type}`);
    }

    return null;
  }

  static handleObj(pageIndex, id, type, exportedData) {
    const pageObjs = this.pageObjs(pageIndex);

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
}
