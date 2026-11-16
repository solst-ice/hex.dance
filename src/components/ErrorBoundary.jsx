import { Component, Fragment } from 'react'

const buttonStyle = { margin: '0 10px' }

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, resetKey: 0 }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Render error:', error, info?.componentStack)
  }

  // Remounting the children gives the app fresh state, so the file that broke it is dropped
  handleReset = () => {
    this.setState(({ resetKey }) => ({ error: null, resetKey: resetKey + 1 }))
  }

  render() {
    const { error, resetKey } = this.state

    if (error) {
      return (
        <div className="container">
          <div className="description" role="alert" style={{ borderColor: 'var(--hd-danger)' }}>
            <h1>SOMETHING BROKE</h1>
            <p>hex.dance hit an error and could not show this page:</p>
            <pre style={{ color: 'var(--hd-danger)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {String(error?.message || error)}
            </pre>
            <p style={{ textAlign: 'center' }}>
              <button className="edit-button" style={buttonStyle} onClick={this.handleReset}>
                TRY ANOTHER FILE
              </button>
              <button className="edit-button" style={buttonStyle} onClick={() => window.location.reload()}>
                RELOAD
              </button>
            </p>
          </div>
        </div>
      )
    }

    // eslint-disable-next-line react/prop-types -- the project does not use prop-types
    return <Fragment key={resetKey}>{this.props.children}</Fragment>
  }
}

export default ErrorBoundary
