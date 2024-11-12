/** @implements {CanvasRenderingContext2D} */
export class CanvasRecorder {
  /** @type {CanvasRenderingContext2D} */
  #ctx;

  #groupsStack = [];

  #closedGroups = [];

  /** @param {CanvasRenderingContext2D} */
  constructor(ctx) {
    this.#ctx = ctx;
    this.#startGroup();
  }

  static startGroupRecording(ctx, data) {
    return #startGroup in ctx ? ctx.#startGroup(data) : null;
  }

  static endGroupRecording(ctx) {
    return #endGroup in ctx ? ctx.#endGroup() : null;
  }

  /** @param {CanvasRecorder} */
  static getFinishedGroups(ctx) {
    return ctx.#closedGroups;
  }

  static pushGroup(ctx, minX, maxX, minY, maxY, data) {
    if (#closedGroups in ctx) {
      const { width, height } = ctx.canvas;
      const group = {
        minX: minX / width,
        maxX: maxX / width,
        minY: minY / height,
        maxY: maxY / height,
        data,
      };
      ctx.#closedGroups.push(group);
      return group;
    }
    return null;
  }

  #startGroup(data) {
    this.#groupsStack.push({
      minX: Infinity,
      maxX: 0,
      minY: Infinity,
      maxY: 0,
      data,
    });
    return this.#currentGroup;
  }

  #endGroup() {
    const group = this.#groupsStack.pop();
    this.#currentGroup.maxX = Math.max(this.#currentGroup.maxX, group.maxX);
    this.#currentGroup.minX = Math.min(this.#currentGroup.minX, group.minX);
    this.#currentGroup.maxY = Math.max(this.#currentGroup.maxY, group.maxY);
    this.#currentGroup.minY = Math.min(this.#currentGroup.minY, group.minY);

    this.#closedGroups.push({
      minX: group.minX / this.#ctx.canvas.width,
      maxX: group.maxX / this.#ctx.canvas.width,
      minY: group.minY / this.#ctx.canvas.height,
      maxY: group.maxY / this.#ctx.canvas.height,
      data: group.data,
    });

    return group;
  }

  get #currentGroup() {
    return this.#groupsStack[this.#groupsStack.length - 1];
  }

  #unknown() {
    this.#currentGroup.minX = 0;
    this.#currentGroup.maxX = Infinity;
    this.#currentGroup.minY = 0;
    this.#currentGroup.maxY = Infinity;
  }

  #registerBox(minX, maxX, minY, maxY) {
    const matrix = this.#ctx.getTransform();

    ({ x: minX, y: minY } = matrix.transformPoint(new DOMPoint(minX, minY)));
    ({ x: maxX, y: maxY } = matrix.transformPoint(new DOMPoint(maxX, maxY)));
    if (maxX < minX) [maxX, minX] = [minX, maxX];
    if (maxY < minY) [maxY, minY] = [minY, maxY];

    const currentGroup = this.#currentGroup;
    currentGroup.minX = Math.min(currentGroup.minX, minX);
    currentGroup.maxX = Math.max(currentGroup.maxX, maxX);
    currentGroup.minY = Math.min(currentGroup.minY, minY);
    currentGroup.maxY = Math.max(currentGroup.maxY, maxY);
  }

  #registerPoint(x, y) {
    const matrix = this.#ctx.getTransform();
    ({ x, y } = matrix.transformPoint(new DOMPoint(x, y)));

    const currentGroup = this.#currentGroup;
    currentGroup.minX = Math.min(currentGroup.minX, x);
    currentGroup.maxX = Math.max(currentGroup.maxX, x);
    currentGroup.minY = Math.min(currentGroup.minY, y);
    currentGroup.maxY = Math.max(currentGroup.maxY, y);
  }

  get canvas() {
    return this.#ctx.canvas;
  }

  fillText(text, x, y, maxWidth) {
    const measure = this.#ctx.measureText(text);
    this.#registerBox(
      x,
      x + Math.min(measure.width, maxWidth ?? Infinity),
      y - measure.actualBoundingBoxAscent,
      y + measure.actualBoundingBoxDescent
    );

    this.#ctx.fillText(text, x, y, maxWidth);
  }

  fillRect(x, y, width, height) {
    this.#registerBox(x, x + width, y, y + height);
    this.#ctx.fillRect(x, y, width, height);
  }

  drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
    this.#registerBox(
      dx ?? sx,
      (dx ?? sx) + (dw ?? sw),
      dy ?? sy,
      (dy ?? sy) + (dh ?? sh)
    );

    this.#ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  //moveTo(x, y) {
  //  this.#registerPoint(x, y);
  //  this.#ctx.moveTo(x, y);
  //}

  static {
    const passThrough = [
      "save",
      "restore",

      // transforms
      "transform",
      "translate",
      "rotate",
      "scale",
    ];
    for (const name of passThrough) {
      CanvasRecorder.prototype[name] = function () {
        this.#ctx[name].apply(this.#ctx, arguments);
      };
    }

    const originalDescriptors = Object.getOwnPropertyDescriptors(
      CanvasRenderingContext2D.prototype
    );
    for (const name of Object.keys(originalDescriptors)) {
      if (Object.hasOwn(CanvasRecorder.prototype, name)) continue;
      if (typeof name !== "string") continue;

      const desc = originalDescriptors[name];
      if (desc.get) {
        Object.defineProperty(CanvasRecorder.prototype, name, {
          configurable: true,
          get: function () {
            return this.#ctx[name];
          },
          set: function (v) {
            this.#ctx[name] = v;
          },
        });
        continue;
      }

      if (typeof desc.value !== "function") continue;
      if (/^(?:get|set|is)[A-Z]/.test(name)) {
        // These functions just query or set some state, but perform no drawing
        CanvasRecorder.prototype[name] = function () {
          return this.#ctx[name].apply(this.#ctx, arguments);
        };
      } else {
        CanvasRecorder.prototype[name] = function () {
          //console.warn(`Untracked call to ${name}`);
          this.#unknown();
          return this.#ctx[name].apply(this.#ctx, arguments);
        };
      }
    }
  }
}
