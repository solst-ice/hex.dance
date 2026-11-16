/* eslint-disable react/prop-types -- the project does not use prop-types */
import { Component } from 'react'

/** Keeps a failing panel from taking the rest of the workspace down with it. */
class PanelBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, resetKey: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  // A new file (resetKey) gives the panel another chance
  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey }
    return null
  }

  componentDidCatch(error, info) {
    console.error(`Panel "${this.props.title}" failed:`, error, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <section className="hd-panel" role="alert">
          <p className="hd-warning">The {this.props.title} panel hit an error: {String(this.state.error?.message || this.state.error)}</p>
        </section>
      )
    }
    return this.props.children
  }
}

export default PanelBoundary
