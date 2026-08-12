/**
 * Opening files: drag-and-drop and a picker.
 *
 * Both paths exist because both are used — a drag is faster for a folder of
 * runs, and the picker is the only route on a tablet and the only one reachable
 * from the keyboard. The drop target is a `<label>` wrapping a real file input,
 * so keyboard and screen-reader users get the native control rather than a
 * simulation of one.
 */

import { useCallback, useRef, useState } from 'react'

export interface FileDropZoneProps {
  onFiles: (files: File[]) => void
  disabled: boolean
}

/** Everything the desktop's dialog accepted. */
const ACCEPT = '.csv,text/csv'

function csvFilesFrom(list: FileList | null): File[] {
  if (list === null) return []
  return [...list].filter((file) => file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv')
}

export function FileDropZone(props: FileDropZoneProps): React.JSX.Element {
  const [active, setActive] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const dragDepth = useRef(0)

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setActive(false)
      if (props.disabled) return
      const files = csvFilesFrom(event.dataTransfer.files)
      if (files.length > 0) props.onFiles(files)
    },
    [props],
  )

  return (
    <label
      className={active ? 'dropzone dropzone--active' : 'dropzone'}
      onDragEnter={(event) => {
        event.preventDefault()
        // Counted rather than toggled: dragging over a child fires enter/leave
        // pairs that would otherwise make the highlight flicker.
        dragDepth.current += 1
        setActive(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setActive(false)
      }}
      onDrop={onDrop}
    >
      <span className="dropzone__title">CSVファイルをドロップ</span>
      <span>
        または<span className="visually-hidden">ファイル選択ボタンで</span>ファイルを選択してください。
        複数選択できます。
      </span>
      <span className="panel__hint">
        解析はブラウザ内で完結します。ファイルがアップロードされることはありません。
      </span>
      <input
        className="visually-hidden"
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        disabled={props.disabled}
        onChange={(event) => {
          const files = csvFilesFrom(event.target.files)
          if (files.length > 0) props.onFiles(files)
          // Reset so selecting the same file twice fires a change both times.
          event.target.value = ''
        }}
      />
      <span className="button" aria-hidden="true">
        ファイルを選択
      </span>
    </label>
  )
}
