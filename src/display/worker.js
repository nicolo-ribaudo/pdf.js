import { CanvasGraphics } from "./canvas.js";
import { OffscreenCanvasFactory } from "./canvas_factory.js";
import { PDFObjects } from "./display_utils.js";

let gfx = null;
let canvas = null;

// TODO: use better/proper message handling

self.onmessage = async function (event) {
  const { type } = event.data;
  switch (type) {
    case "init":
      {
        canvas = event.data.canvas;
        const {
          drawingParams: { transform, viewport, background, transparency },
          objs,
          commonObjs,
          optionalContentConfig,
          map,
          colors,
        } = event.data;
        const ctx = canvas.getContext("2d");
        const pdfCommonObjs = PDFObjects.fromJSON(commonObjs);
        const pdfObjs = PDFObjects.fromJSON(objs);
        gfx = new CanvasGraphics(
          ctx,
          pdfCommonObjs,
          pdfObjs,
          OffscreenCanvasFactory,
          null,
          { optionalContentConfig },
          map,
          colors
        );
        gfx.beginDrawing({
          transform,
          viewport,
          transparency,
          background,
        });
      }
      break;
    case "render":
      {
        const { renderParams } = event.data;
        const operatorListIdx = gfx.executeOperatorList(...renderParams);
        const bitmap = await canvas.transferToImageBitmap();
        self.postMessage({ type: "renderComplete", bitmap, operatorListIdx }, [
          bitmap,
        ]);
      }
      break;
    case "end":
      gfx.endDrawing();
  }
};
