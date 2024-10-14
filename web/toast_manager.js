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

class ToastManager {
  #toastElement;

  #duration;

  #timeoutID = null;

  #controller = null;

  #boundHide = null;

  constructor(elem, duration) {
    this.#toastElement = elem;
    this.#duration = duration;
  }

  show(action, type) {
    if (this.#timeoutID) {
      this.#finalizeTimeout();
    }
    if (this.#controller) {
      this.#finalizeController();
    }
    this.#toastElement.setAttribute("data-l10n-args", JSON.stringify({ type }));
    this.#toastElement.removeAttribute("hidden");
    this.#boundHide = this.#hide.bind(this);
    this.#timeoutID = setTimeout(this.#boundHide, this.#duration);
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
      .addEventListener("click", this.#boundHide, {
        signal: this.#controller.signal,
      });
  }

  #finalizeTimeout() {
    clearTimeout(this.#timeoutID);
    this.#timeoutID = null;
  }

  #finalizeController() {
    this.#controller.abort();
    this.#controller = null;
  }

  #hide() {
    this.#toastElement.setAttribute("hidden", "");
    this.#finalizeTimeout();
    this.#finalizeController();
  }
}

export { ToastManager };
