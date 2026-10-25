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
// The licence stays with the name of the library, the version is what
// the panel shows.
link.title = `libpoppy ${LIBPOPPY_VERSION}`;
footnote.append('engine: ', link, ' ', LIBPOPPY_VERSION);
host.append(footnote);
