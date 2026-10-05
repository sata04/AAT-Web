/**
 * The Python sources the engine installs into Pyodide's filesystem at boot.
 *
 * The single source of truth for the renderer is `poster-renderer/src/poster_renderer/` — this
 * file imports those .py files *as raw strings* (`?raw`), so there is exactly one copy of the
 * code: edit it and the worker chunk rebuilds automatically in dev and build, with no
 * copy-to-public step to drift out of sync.
 */

import initSource from '../../../../../poster-renderer/src/poster_renderer/__init__.py?raw'
import errorsSource from '../../../../../poster-renderer/src/poster_renderer/errors.py?raw'
import limitsSource from '../../../../../poster-renderer/src/poster_renderer/limits.py?raw'
import presetSource from '../../../../../poster-renderer/src/poster_renderer/preset.py?raw'
import renderSource from '../../../../../poster-renderer/src/poster_renderer/render.py?raw'
import validationSource from '../../../../../poster-renderer/src/poster_renderer/validation.py?raw'
import versionSource from '../../../../../poster-renderer/src/poster_renderer/version.py?raw'
import entrySource from './entry.py?raw'

export interface PythonSourceFile {
  /** Path inside the Pyodide filesystem, relative to the engine's source root. */
  readonly path: string
  readonly source: string
}

export const POSTER_PYTHON_SOURCES: readonly PythonSourceFile[] = [
  { path: 'poster_renderer/__init__.py', source: initSource },
  { path: 'poster_renderer/errors.py', source: errorsSource },
  { path: 'poster_renderer/limits.py', source: limitsSource },
  { path: 'poster_renderer/preset.py', source: presetSource },
  { path: 'poster_renderer/render.py', source: renderSource },
  { path: 'poster_renderer/validation.py', source: validationSource },
  { path: 'poster_renderer/version.py', source: versionSource },
  { path: 'engine_entry.py', source: entrySource },
]
