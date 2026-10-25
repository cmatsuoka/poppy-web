import './styles.css';
import { LIBPOPPY_VERSION } from '../build/version';
import { PoppyEngine } from './audio/engine';
import { Panel } from './ui/panel';

const host = document.querySelector<HTMLElement>('#app');
if (host === null) {
  throw new Error('missing #app mount point');
}

const engine = new PoppyEngine();
new Panel(engine, host);

// The audio graph is built while the page loads, so the first press on
// START only has to wake the context up.
void engine.init();

// A handle for the end-to-end checks: the smoke tests drive the engine
// through it and read the panel state back.
(window as unknown as { poppy?: PoppyEngine }).poppy = engine;

const footnote = document.createElement('p');
footnote.className = 'footnote';
const link = document.createElement('a');
link.href = 'https://github.com/cmatsuoka/libpoppy';
link.target = '_blank';
link.rel = 'noreferrer';
link.textContent = 'libpoppy';
link.title = `libpoppy ${LIBPOPPY_VERSION}`;
footnote.append('using ', link, ' ', LIBPOPPY_VERSION);
host.append(footnote);
