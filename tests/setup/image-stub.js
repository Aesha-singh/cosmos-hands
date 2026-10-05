/** Stub Image so TextureLoader immediately resolves or fails without waiting. */
(function () {
  const RealImage = globalThis.Image;
  const isJSDOM = globalThis.navigator && /jsdom/i.test(globalThis.navigator.userAgent || '');

  if (!isJSDOM || RealImage && RealImage.prototype && RealImage.prototype.__cosmosStubbed) return;

  const ImageStub = class {
    constructor() {
      this.complete = true;
      this.naturalWidth = 1;
      this.naturalHeight = 1;
      this.src = '';
      this.crossOrigin = '';
      this.onload = null;
      this.onerror = null;
      this.__cosmosStubbed = true;
    }

    set src(value) {
      this._src = value;
      setTimeout(() => {
        // Resolve most texture loads (the code falls back on error). Resolve on
        // next tick so onload/onerror handlers are bound. To keep tests fast,
        // trigger the "success" path by default and the error path is rare —
        // but loadTexture already treats onerror as a fallback to procedural.
        this.onload?.();
      }, 0);
    }

    get src() {
      return this._src;
    }
  };

  globalThis.Image = ImageStub;
  ImageStub.prototype.__cosmosStubbed = true;
})();