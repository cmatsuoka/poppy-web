/*
 * fit.ts - the machine is scaled down when the viewport has no room for
 * it.
 *
 * The layout of the panel is fluid: the machine is laid out at the width
 * of the page and its sizes follow the viewport. That works until the
 * viewport is too small for the machine, which is what a phone in
 * landscape runs into. Then the whole machine is scaled down as one
 * piece, the way a picture is shrunk to fit its frame.
 *
 * The scaling is done with a transform, so the machine keeps its shape
 * and stays crisp; only its size changes. The room the scaling takes is
 * given back to the page, so the card under the machine moves up under
 * it and the page does not scroll.
 */

/**
 * The machine is scaled down to fit the room it has.
 *
 * The blocks around the machine - the notice above it and the status
 * line under it - keep their room, so they stay on the screen with it.
 */
export class FitScaler {
  private readonly unit: HTMLElement;
  private readonly around: HTMLElement[];
  private readonly observer: ResizeObserver;
  private readonly onResize = (): void => this.fit();

  constructor(unit: HTMLElement, around: HTMLElement[]) {
    this.unit = unit;
    this.around = around;
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.unit);
    window.addEventListener('resize', this.onResize);
  }

  dispose(): void {
    this.observer.disconnect();
    window.removeEventListener('resize', this.onResize);
  }

  /** Scale the machine so that it fits the room it has. */
  fit(): void {
    const stage = this.unit.parentElement;
    if (stage === null) {
      return;
    }

    const width = stage.clientWidth;
    const natural = this.unit.offsetHeight;
    if (natural === 0 || width === 0) {
      return;
    }

    // The ink of the machine can be wider than the box it is laid out in:
    // the panel has a minimum width, and a narrow page lets it stick out
    // to the side. The ink is what has to fit.
    const ink = this.inkWidth();
    const scale = Math.max(
      0.1,
      Math.min(1, width / ink, this.room() / natural),
    );
    const shift = (width - scale * ink) / 2;

    this.unit.style.setProperty('--unit-scale', scale.toFixed(4));
    this.unit.style.setProperty('--unit-shift', `${shift.toFixed(2)}px`);
    // The room the scaling frees is taken out of the page, so the status
    // line and the card move up under the machine.
    this.unit.style.marginBottom = `${(scale - 1) * natural}px`;
  }

  /** The height the machine has: the page, less the room around it. */
  private room(): number {
    const body = getComputedStyle(document.body);
    const padding =
      (parseFloat(body.paddingTop) || 0) +
      (parseFloat(body.paddingBottom) || 0);
    let around = 0;
    for (const block of this.around) {
      // A block that is not on the page takes no room.
      if (block.getClientRects().length === 0) {
        continue;
      }
      const style = getComputedStyle(block);
      around +=
        block.offsetHeight +
        (parseFloat(style.marginTop) || 0) +
        (parseFloat(style.marginBottom) || 0);
    }
    return window.innerHeight - padding - around;
  }

  /**
   * The width of the machine as it is drawn, which can be more than the
   * width of the box it is laid out in.
   */
  private inkWidth(): number {
    const box = this.unit.getBoundingClientRect();
    const layout = this.unit.offsetWidth;
    const scale = layout > 0 ? box.width / layout : 1;
    let right = box.left;
    for (const child of this.unit.querySelectorAll<HTMLElement>('*')) {
      const rect = child.getBoundingClientRect();
      if (rect.width > 0 && rect.right > right) {
        right = rect.right;
      }
    }
    return (right - box.left) / (scale > 0 ? scale : 1);
  }
}
