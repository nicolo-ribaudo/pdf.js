/* Copyright 2024 Mozilla Foundation
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

import {
  awaitPromise,
  closePages,
  createPromise,
  getSpanRectFromText,
  loadAndWait,
  scrollIntoView,
  waitForPageRendered,
} from "./test_utils.mjs";
import { PNG } from "pngjs";

describe("PDF viewer", () => {
  describe("Zoom origin", () => {
    let pages;

    beforeAll(async () => {
      pages = await loadAndWait(
        "tracemonkey.pdf",
        ".textLayer .endOfContent",
        "page-width",
        null,
        { page: 2 }
      );
    });

    afterAll(async () => {
      await closePages(pages);
    });

    async function getTextAt(page, pageNumber, coordX, coordY) {
      await page.waitForFunction(
        pageNum =>
          !document.querySelector(
            `.page[data-page-number="${pageNum}"] > .textLayer`
          ).hidden,
        {},
        pageNumber
      );
      return page.evaluate(
        (x, y) => document.elementFromPoint(x, y)?.textContent,
        coordX,
        coordY
      );
    }

    it("supports specifiying a custom origin", async () => {
      await Promise.all(
        pages.map(async ([browserName, page]) => {
          // We use this text span of page 2 because:
          // - it's in the visible area even when zooming at page-width
          // - it's small, so it easily catches if the page moves too much
          // - it's in a "random" position: not near the center of the
          //   viewport, and not near the borders
          const text = "guards";

          const rect = await getSpanRectFromText(page, 2, text);
          const originX = rect.x + rect.width / 2;
          const originY = rect.y + rect.height / 2;

          await page.evaluate(
            origin => {
              window.PDFViewerApplication.pdfViewer.increaseScale({
                scaleFactor: 2,
                origin,
              });
            },
            [originX, originY]
          );
          const textAfterZoomIn = await getTextAt(page, 2, originX, originY);
          expect(textAfterZoomIn)
            .withContext(`In ${browserName}, zoom in`)
            .toBe(text);

          await page.evaluate(
            origin => {
              window.PDFViewerApplication.pdfViewer.decreaseScale({
                scaleFactor: 0.8,
                origin,
              });
            },
            [originX, originY]
          );
          const textAfterZoomOut = await getTextAt(page, 2, originX, originY);
          expect(textAfterZoomOut)
            .withContext(`In ${browserName}, zoom out`)
            .toBe(text);
        })
      );
    });
  });

  describe("Zoom with the mouse wheel", () => {
    let pages;

    beforeAll(async () => {
      pages = await loadAndWait("empty.pdf", ".textLayer .endOfContent", 1000);
    });

    afterAll(async () => {
      await closePages(pages);
    });

    it("must check that we can zoom with the mouse wheel and pressed control key", async () => {
      await Promise.all(
        pages.map(async ([browserName, page]) => {
          await page.keyboard.down("Control");
          let zoom = 10;
          const zoomGetter = () =>
            page.evaluate(
              () => window.PDFViewerApplication.pdfViewer.currentScale
            );
          while (zoom > 0.1) {
            await page.mouse.wheel({ deltaY: 100 });
            zoom = await zoomGetter();
          }
          while (zoom < 10) {
            await page.mouse.wheel({ deltaY: -100 });
            zoom = await zoomGetter();
          }
          await page.keyboard.up("Control");
        })
      );
    });
  });

  describe("Zoom commands", () => {
    let pages;

    beforeAll(async () => {
      pages = await loadAndWait("tracemonkey.pdf", ".textLayer .endOfContent");
    });

    afterAll(async () => {
      await closePages(pages);
    });

    it("must check that zoom commands don't scroll the document", async () => {
      await Promise.all(
        pages.map(async ([browserName, page]) => {
          for (let i = 0; i < 10; i++) {
            await page.evaluate(() => window.PDFViewerApplication.zoomIn());
            await page.evaluate(() => window.PDFViewerApplication.zoomReset());
            await page.waitForSelector(
              `.page[data-page-number="1"] .textLayer .endOfContent`
            );
            const scrollTop = await page.evaluate(
              () => document.getElementById("viewerContainer").scrollTop
            );
            expect(scrollTop < 100)
              .withContext(`In ${browserName}`)
              .toBe(true);
          }
        })
      );
    });
  });

  describe("CSS-only zoom", () => {
    function createPromiseForFirstPageRendered(page) {
      return createPromise(page, (resolve, reject) => {
        const controller = new AbortController();
        window.PDFViewerApplication.eventBus.on(
          "pagerendered",
          ({ pageNumber, timestamp }) => {
            if (pageNumber === 1) {
              resolve(timestamp);
              controller.abort();
            }
          },
          { signal: controller.signal }
        );
        setTimeout(reject, 1000, new Error("Timeout"));
      });
    }

    describe("forced (maxCanvasPixels: 0)", () => {
      let pages;

      beforeAll(async () => {
        pages = await loadAndWait(
          "tracemonkey.pdf",
          ".textLayer .endOfContent",
          null,
          null,
          { maxCanvasPixels: 0 }
        );
      });

      afterAll(async () => {
        await closePages(pages);
      });

      it("respects drawing delay when zooming out", async () => {
        await Promise.all(
          pages.map(async ([browserName, page]) => {
            const promise = await createPromiseForFirstPageRendered(page);

            const start = await page.evaluate(() => {
              const startTime = performance.now();
              window.PDFViewerApplication.pdfViewer.decreaseScale({
                drawingDelay: 100,
                scaleFactor: 0.9,
              });
              return startTime;
            });

            const end = await awaitPromise(promise);

            expect(end - start)
              .withContext(`In ${browserName}`)
              .toBeGreaterThanOrEqual(100);
          })
        );
      });

      it("respects drawing delay when zooming in", async () => {
        await Promise.all(
          pages.map(async ([browserName, page]) => {
            const promise = await createPromiseForFirstPageRendered(page);

            const start = await page.evaluate(() => {
              const startTime = performance.now();
              window.PDFViewerApplication.pdfViewer.increaseScale({
                drawingDelay: 100,
                scaleFactor: 1.1,
              });
              return startTime;
            });

            const end = await awaitPromise(promise);

            expect(end - start)
              .withContext(`In ${browserName}`)
              .toBeGreaterThanOrEqual(100);
          })
        );
      });
    });

    describe("triggers when going bigger than maxCanvasPixels", () => {
      let pages;

      const MAX_CANVAS_PIXELS = new Map();

      beforeAll(async () => {
        pages = await loadAndWait(
          "tracemonkey.pdf",
          ".textLayer .endOfContent",
          null,
          null,
          async (page, browserName) => {
            const ratio = await page.evaluate(() => window.devicePixelRatio);
            const maxCanvasPixels = 1_000_000 * ratio ** 2;
            MAX_CANVAS_PIXELS.set(browserName, maxCanvasPixels);

            return { maxCanvasPixels };
          }
        );
      });

      beforeEach(async () => {
        await Promise.all(
          pages.map(async ([browserName, page]) => {
            const handle = await waitForPageRendered(page);
            if (
              await page.evaluate(() => {
                if (
                  window.PDFViewerApplication.pdfViewer.currentScale !== 0.5
                ) {
                  window.PDFViewerApplication.pdfViewer.currentScale = 0.5;
                  return true;
                }
                return false;
              })
            ) {
              await awaitPromise(handle);
            }
          })
        );
      });

      afterAll(async () => {
        await closePages(pages);
      });

      function getCanvasSize(page) {
        return page.evaluate(() => {
          const canvas = window.document.querySelector(".canvasWrapper canvas");
          return canvas.width * canvas.height;
        });
      }

      // MAX_CANVAS_PIXELS must be big enough that the originally rendered
      // canvas still has enough space to grow before triggering CSS-only zoom
      it("test correctly configured", async () => {
        await Promise.all(
          pages.map(async ([browserName, page]) => {
            const canvasSize = await getCanvasSize(page);

            expect(canvasSize)
              .withContext(`In ${browserName}`)
              .toBeLessThan(MAX_CANVAS_PIXELS.get(browserName) / 4);
            expect(canvasSize)
              .withContext(`In ${browserName}`)
              .toBeGreaterThan(MAX_CANVAS_PIXELS.get(browserName) / 16);
          })
        );
      });

      it("does not trigger CSS-only zoom below maxCanvasPixels", async () => {
        await Promise.all(
          pages.map(async ([browserName, page]) => {
            const originalCanvasSize = await getCanvasSize(page);
            const factor = 2;

            const handle = await waitForPageRendered(page);
            await page.evaluate(scaleFactor => {
              window.PDFViewerApplication.pdfViewer.increaseScale({
                drawingDelay: 0,
                scaleFactor,
              });
            }, factor);
            await awaitPromise(handle);

            const canvasSize = await getCanvasSize(page);

            expect(canvasSize)
              .withContext(`In ${browserName}`)
              .toBe(originalCanvasSize * factor ** 2);

            expect(canvasSize)
              .withContext(`In ${browserName}, MAX_CANVAS_PIXELS`)
              .toBeLessThan(MAX_CANVAS_PIXELS.get(browserName));
          })
        );
      });

      it("triggers CSS-only zoom above maxCanvasPixels", async () => {
        await Promise.all(
          pages.map(async ([browserName, page]) => {
            const originalCanvasSize = await getCanvasSize(page);
            const factor = 4;

            const handle = await waitForPageRendered(page);
            await page.evaluate(scaleFactor => {
              window.PDFViewerApplication.pdfViewer.increaseScale({
                drawingDelay: 0,
                scaleFactor,
              });
            }, factor);
            await awaitPromise(handle);

            const canvasSize = await getCanvasSize(page);

            expect(canvasSize)
              .withContext(`In ${browserName}`)
              .toBeLessThan(originalCanvasSize * factor ** 2);

            expect(canvasSize)
              .withContext(`In ${browserName}, <= MAX_CANVAS_PIXELS`)
              .toBeLessThanOrEqual(MAX_CANVAS_PIXELS.get(browserName));

            expect(canvasSize)
              .withContext(`In ${browserName}, > MAX_CANVAS_PIXELS * 0.99`)
              .toBeGreaterThan(MAX_CANVAS_PIXELS.get(browserName) * 0.99);
          })
        );
      });
    });
  });

  describe("Canvas fits the page", () => {
    let pages;

    beforeAll(async () => {
      pages = await loadAndWait(
        "issue18694.pdf",
        ".textLayer .endOfContent",
        "page-width"
      );
    });

    afterAll(async () => {
      await closePages(pages);
    });

    it("must check that canvas perfectly fits the page whatever the zoom level is", async () => {
      await Promise.all(
        pages.map(async ([browserName, page]) => {
          const debug = false;

          // The pdf has a single page with a red background.
          // We set the viewer background to red, because when screenshoting
          // some part of the viewer background can be visible.
          // But here we don't care about the viewer background: we only
          // care about the page background and the canvas default color.

          await page.evaluate(() => {
            document.body.style.background = "#ff0000";
            const toolbar = document.querySelector(".toolbar");
            toolbar.style.display = "none";
          });
          await page.waitForSelector(".toolbar", { visible: false });
          await page.evaluate(() => {
            const p = document.querySelector(`.page[data-page-number="1"]`);
            p.style.border = "none";
          });

          for (let i = 0; ; i++) {
            const handle = await waitForPageRendered(page);
            await page.evaluate(() => window.PDFViewerApplication.zoomOut());
            await awaitPromise(handle);
            await scrollIntoView(page, `.page[data-page-number="1"]`);

            const element = await page.$(`.page[data-page-number="1"]`);
            const png = await element.screenshot({
              type: "png",
              path: debug ? `foo${i}.png` : "",
            });
            const pageImage = PNG.sync.read(Buffer.from(png));
            let buffer = new Uint32Array(pageImage.data.buffer);

            // Search for the first red pixel.
            const j = buffer.indexOf(0xff0000ff);
            buffer = buffer.slice(j);

            expect(buffer.every(x => x === 0xff0000ff))
              .withContext(`In ${browserName}, in the ${i}th zoom in`)
              .toBe(true);

            const currentScale = await page.evaluate(
              () => window.PDFViewerApplication.pdfViewer.currentScale
            );
            if (currentScale <= 0.1) {
              break;
            }
          }
        })
      );
    });
  });

  describe("Detail view on zoom", () => {
    function setupPages(zoom, maxCanvasPixels, width, height) {
      const pixelRatios = [1, 2];

      let pagesWithRatios;

      beforeAll(async () => {
        pagesWithRatios = await Promise.all(
          pixelRatios.map(devicePixelRatio =>
            loadAndWait(
              "colors.pdf",
              null,
              zoom,
              {
                // When running Firefox with Puppeteer, setting the
                // devicePixelRatio Puppeteer option does not properly set
                // the `window.devicePixelRatio` value. Set it manually.
                earlySetup: `() => {
                  window.devicePixelRatio = ${devicePixelRatio};
                }`,
              },
              { maxCanvasPixels: maxCanvasPixels * devicePixelRatio ** 2 },
              { height, width, devicePixelRatio }
            ).then(pages => [pages, devicePixelRatio])
          )
        );
      });

      afterAll(async () => {
        await Promise.all(pagesWithRatios.map(([pages]) => closePages(pages)));
      });

      return function forEachPage(fn) {
        const pagesByBrowser = new Map();
        for (const [pages, devicePixelRatio] of pagesWithRatios) {
          for (const [browserName, page] of pages) {
            if (!pagesByBrowser.has(browserName)) {
              pagesByBrowser.set(browserName, []);
            }
            pagesByBrowser.get(browserName).push([page, devicePixelRatio]);
          }
        }

        // Run tests in different browsers in parallel, but for any given
        // browser run the tests with different pixel ratios sequentially making
        // sure that the page that is being tested is in the front tab.
        return Promise.all(
          Array.from(pagesByBrowser.entries(), async ([browserName, pages]) => {
            for (const [page, pixelRatio] of pages) {
              await page.bringToFront();
              await fn(browserName, page, pixelRatio);
            }
          })
        );
      };
    }

    function extractCanvases(pageNumber) {
      const pageOne = document.querySelector(
        `.page[data-page-number='${pageNumber}']`
      );
      return Array.from(pageOne.querySelectorAll("canvas"), canvas => {
        const { width, height } = canvas;
        const ctx = canvas.getContext("2d");
        const topLeft = ctx.getImageData(2, 2, 1, 1).data;
        const bottomRight = ctx.getImageData(width - 3, height - 3, 1, 1).data;
        return {
          size: width * height,
          topLeft: globalThis.pdfjsLib.Util.makeHexColor(...topLeft),
          bottomRight: globalThis.pdfjsLib.Util.makeHexColor(...bottomRight),
        };
      });
    }

    function waitForDetailRendered(page) {
      return createPromise(page, resolve => {
        const controller = new AbortController();
        window.PDFViewerApplication.eventBus.on(
          "pagerendered",
          ({ source }) => {
            if (source.constructor.name === "PDFPageDetailView") {
              resolve();
              controller.abort();
            }
          },
          { signal: controller.signal }
        );
      });
    }

    describe("setupPages()", () => {
      const forEachPage = setupPages("100%", 1e6, 800, 600);

      it("sets the proper devicePixelRatio", async () => {
        await forEachPage(async (browserName, page, pixelRatio) => {
          const devicePixelRatio = await page.evaluate(
            () => window.devicePixelRatio
          );

          expect(devicePixelRatio)
            .withContext(`In ${browserName}, ${pixelRatio}x`)
            .toBe(pixelRatio);
        });
      });
    });

    describe("when zooming in past max canvas size", () => {
      const maxCanvasPixels = 1e6;
      const forEachPage = setupPages("100%", maxCanvasPixels, 800, 600);

      it("must render the detail view", async () => {
        await forEachPage(async (browserName, page, pixelRatio) => {
          await page.waitForSelector(".page[data-page-number='1'] .textLayer");

          const before = await page.evaluate(extractCanvases, 1);

          expect(before.length)
            .withContext(`In ${browserName}, ${pixelRatio}x, before`)
            .toBe(1);
          expect(before[0].size)
            .withContext(`In ${browserName}, ${pixelRatio}x, before`)
            .toBeLessThan(maxCanvasPixels * pixelRatio ** 2);
          expect(before[0])
            .withContext(`In ${browserName}, ${pixelRatio}x, before`)
            .toEqual(
              jasmine.objectContaining({
                topLeft: "#85200c", // dark berry
                bottomRight: "#b6d7a8", // light green
              })
            );

          const factor = 3;
          // Check that we are going to trigger CSS zoom.
          expect(before[0].size * factor ** 2)
            .withContext(`In ${browserName}, ${pixelRatio}x`)
            .toBeGreaterThan(maxCanvasPixels * pixelRatio ** 2);

          const handle = await waitForDetailRendered(page);
          await page.evaluate(scaleFactor => {
            window.PDFViewerApplication.pdfViewer.updateScale({
              drawingDelay: 0,
              scaleFactor,
            });
          }, factor);
          await awaitPromise(handle);

          const after = await page.evaluate(extractCanvases, 1);

          expect(after.length)
            .withContext(`In ${browserName}, ${pixelRatio}x, after`)
            .toBe(2);
          expect(after[0].size)
            .withContext(`In ${browserName}, ${pixelRatio}x, after (first)`)
            .toBeLessThan(4e6);
          expect(after[0])
            .withContext(`In ${browserName}, ${pixelRatio}x, after (first)`)
            .toEqual(
              jasmine.objectContaining({
                topLeft: "#85200c", // dark berry
                bottomRight: "#b6d7a8", // light green
              })
            );
          expect(after[1].size)
            .withContext(`In ${browserName}, ${pixelRatio}x, after (second)`)
            .toBeLessThan(4e6);
          expect(after[1])
            .withContext(`In ${browserName}, ${pixelRatio}x, after (second)`)
            .toEqual(
              jasmine.objectContaining({
                topLeft: "#85200c", // dark berry
                bottomRight: "#ff0000", // bright red
              })
            );
        });
      });
    });

    describe("when starting already zoomed in past max canvas size", () => {
      const forEachPage = setupPages("300%", 1e6, 800, 600);

      it("must render the detail view", async () => {
        await forEachPage(async (browserName, page, pixelRatio) => {
          await page.waitForSelector(
            ".page[data-page-number='1'] canvas:nth-child(2)"
          );

          const canvases = await page.evaluate(extractCanvases, 1);

          expect(canvases.length)
            .withContext(`In ${browserName}, ${pixelRatio}x`)
            .toBe(2);
          expect(canvases[0].size)
            .withContext(`In ${browserName}, ${pixelRatio}x (first)`)
            .toBeLessThan(4e6);
          expect(canvases[0])
            .withContext(`In ${browserName}, ${pixelRatio}x (first)`)
            .toEqual(
              jasmine.objectContaining({
                topLeft: "#85200c", // dark berry
                bottomRight: "#b6d7a8", // light green
              })
            );
          expect(canvases[1].size)
            .withContext(`In ${browserName}, ${pixelRatio}x (second)`)
            .toBeLessThan(4e6);
          expect(canvases[1])
            .withContext(`In ${browserName}, ${pixelRatio}x (second)`)
            .toEqual(
              jasmine.objectContaining({
                topLeft: "#85200c", // dark berry
                bottomRight: "#ff0000", // bright red
              })
            );
        });
      });
    });

    describe("when scrolling", () => {
      const forEachPage = setupPages("300%", 1e6, 800, 600);

      it("must update the detail view", async () => {
        await forEachPage(async (browserName, page, pixelRatio) => {
          await page.waitForSelector(
            ".page[data-page-number='1'] canvas:nth-child(2)"
          );

          const handle = await waitForDetailRendered(page);
          await page.evaluate(() => {
            const container = document.getElementById("viewerContainer");
            container.scrollTop += 1600;
            container.scrollLeft += 1100;
          });
          await awaitPromise(handle);

          const canvases = await page.evaluate(extractCanvases, 1);

          expect(canvases.length)
            .withContext(`In ${browserName}, ${pixelRatio}x`)
            .toBe(2);
          expect(canvases[1].size)
            .withContext(`In ${browserName}, ${pixelRatio}x`)
            .toBeLessThan(4e6);
          expect(canvases[1])
            .withContext(`In ${browserName}, ${pixelRatio}x`)
            .toEqual(
              jasmine.objectContaining({
                topLeft: "#ff9900", // bright orange
                bottomRight: "#ffe599", // light yellow
              })
            );
        });
      });
    });

    describe("when scrolling little enough that the existing detail covers the new viewport", () => {
      const forEachPage = setupPages("300%", 1e6, 800, 600);

      it("must not re-create the detail canvas", async () => {
        await forEachPage(async (browserName, page, pixelRatio) => {
          const detailCanvasSelector =
            ".page[data-page-number='1'] canvas:nth-child(2)";

          await page.waitForSelector(detailCanvasSelector);

          const detailCanvasHandle = await page.$(detailCanvasSelector);

          let rendered = false;
          const handle = await waitForDetailRendered(page);
          await page.evaluate(() => {
            const container = document.getElementById("viewerContainer");
            container.scrollTop += 10;
            container.scrollLeft += 10;
          });
          awaitPromise(handle)
            .then(() => {
              rendered = true;
            })
            .catch(() => {});

          // Give some time to the page to re-render. If it re-renders it's
          // a bug, but without waiting we would never catch it.
          await new Promise(resolve => {
            setTimeout(resolve, 100);
          });

          const isSame = await page.evaluate(
            (prev, selector) => prev === document.querySelector(selector),
            detailCanvasHandle,
            detailCanvasSelector
          );

          expect(isSame)
            .withContext(`In ${browserName}, ${pixelRatio}x`)
            .toBe(true);
          expect(rendered)
            .withContext(`In ${browserName}, ${pixelRatio}x`)
            .toBe(false);
        });
      });
    });

    describe("when scrolling to have two visible pages", () => {
      const forEachPage = setupPages("400%", 1e6, 800, 600);

      it("must update the detail view", async () => {
        await forEachPage(async (browserName, page, pixelRatio) => {
          await page.waitForSelector(
            ".page[data-page-number='1'] canvas:nth-child(2)"
          );

          const handle = await createPromise(page, resolve => {
            // wait for two 'pagerendered' events for detail views
            let second = false;
            const { eventBus } = window.PDFViewerApplication;
            eventBus.on("pagerendered", function onPageRendered({ source }) {
              if (source.constructor.name !== "PDFPageDetailView") {
                return;
              }
              if (!second) {
                second = true;
                return;
              }
              eventBus.off("pagerendered", onPageRendered);
              resolve();
            });
          });
          await page.evaluate(() => {
            const container = document.getElementById("viewerContainer");
            container.scrollLeft += 900;
            container.scrollTop += 4200;
          });
          await awaitPromise(handle);

          const [canvases1, canvases2] = await Promise.all([
            page.evaluate(extractCanvases, 1),
            page.evaluate(extractCanvases, 2),
          ]);

          expect(canvases1.length)
            .withContext(`In ${browserName}, ${pixelRatio}x, first page`)
            .toBe(2);
          expect(canvases1[1].size)
            .withContext(`In ${browserName}, ${pixelRatio}x, first page`)
            .toBeLessThan(4e6);
          expect(canvases1[1])
            .withContext(`In ${browserName}, ${pixelRatio}x, first page`)
            .toEqual(
              jasmine.objectContaining({
                topLeft: "#38761d", // dark green
                bottomRight: "#b6d7a8", // light green
              })
            );

          expect(canvases2.length)
            .withContext(`In ${browserName}, ${pixelRatio}x, second page`)
            .toBe(2);
          expect(canvases2[1].size)
            .withContext(`In ${browserName}, ${pixelRatio}x, second page`)
            .toBeLessThan(4e6);
          expect(canvases2[1])
            .withContext(`In ${browserName}, ${pixelRatio}x, second page`)
            .toEqual(
              jasmine.objectContaining({
                topLeft: "#134f5c", // dark cyan
                bottomRight: "#a2c4c9", // light cyan
              })
            );
        });
      });
    });
  });
});
