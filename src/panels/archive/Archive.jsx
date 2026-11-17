import { useMemo } from 'react'
import { useFile } from '../../state/hooks.js'
import { buildTree, renderTree } from './tree.js'

function Archive() {
  const { analysis } = useFile()
  const entries = analysis ? analysis.entries : null
  const tree = useMemo(() => (entries ? renderTree(buildTree(entries)) : ''), [entries])
  if (!analysis) return null

  return (
    <section className="hd-panel">
      <div className="hd-panel-header">
        <h3 className="hd-panel-title">Archive Contents</h3>
      </div>
      <pre className="tree-view">{tree}</pre>
    </section>
  )
}

export default Archive
