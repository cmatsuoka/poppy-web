/*
 * rhythm-name.ts - the printed name of a rhythm.
 *
 * Two of the factory rhythms are marches and carry a meter: "2/4" and
 * "6/8". The panel prints the meter as a fraction, with the top number
 * raised and the bottom number lowered, so the name is put together from
 * parts instead of being written as one string.
 */

/** A name that ends in a meter, like "March 2/4". */
const METER = /^(\D+)(\d)\/(\d)$/;

function fraction(
  tag: 'sup' | 'sub',
  className: string,
  text: string,
): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * Put the printed name of a rhythm into an element. A march shows its
 * meter as a fraction; every other name is plain text.
 */
export function setRhythmName(node: HTMLElement, name: string): void {
  const match = METER.exec(name);
  if (match === null) {
    node.textContent = name;
    return;
  }

  const [, label, top, bottom] = match;
  node.replaceChildren(
    document.createTextNode(label ?? ''),
    fraction('sup', 'fraction-top', top ?? ''),
    fraction('sub', 'fraction-bottom', bottom ?? ''),
  );
}
