import { WORDMARKS } from './wordmark-paths';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A mark of the panel, as a drawing.
 *
 * The face is not shipped with the panel: the marks are cut into outlines
 * (see scripts/generate-wordmarks.py) and the panel draws the outlines.
 * The box of an outline is the box of its ink, so the mark fills the
 * plate it stands on without the empty line of a text that is not there.
 *
 * The drawing carries the word it prints as its accessible name, and the
 * caller decides where it stands and how large it is.
 */
export function printedWord(word: string, className: string): SVGSVGElement {
  const mark = WORDMARKS[word];
  if (mark === undefined) {
    throw new Error(`the word has no outline: ${word}`);
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', mark.viewBox);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', word);
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', mark.path);

  svg.append(path);
  return svg;
}
