class ToastManager {
  #toastElement;

  #duration;

  #timeoutID = null;

  #controller = null;

  constructor(elem, duration) {
    this.#toastElement = elem;
    this.#duration = duration;
  }

  show(action, type) {
    this.#toastElement.setAttribute("data-l10n-args", JSON.stringify({ type }));
    this.#toastElement.removeAttribute("hidden");
    this.#timeoutID = setTimeout(() => {
      this.#hide();
    }, this.#duration);
    this.#controller = new AbortController();
    console.log(this.#toastElement, this.#toastElement.getElementById);
    this.#toastElement
      .querySelector("#annotationRemovedUndoButton")
      .addEventListener(
        "click",
        () => {
          action();
          this.#hide();
        },
        { signal: this.#controller.signal }
      );
    this.#toastElement
      .querySelector("#annotationRemovedCloseButton")
      .addEventListener(
        "click",
        () => {
          this.#hide();
        },
        { signal: this.#controller.signal }
      );
  }

  #hide() {
    this.#toastElement.setAttribute("hidden", "");
    clearTimeout(this.#timeoutID);
    this.#controller.abort();
    this.#controller = null;
  }
}

export { ToastManager };
