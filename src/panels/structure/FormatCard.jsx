/* eslint-disable react/prop-types -- the project does not use prop-types */
import { useId, useState } from 'react'

/** What the format is, where it came from and how to read it; details fold away. */
function FormatCard({ card }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return (
    <section className="sx-card" aria-label={`About ${card.title}`}>
      <div className="sx-card-head">
        <h3 className="sx-card-title">{card.title}</h3>
        <button
          type="button"
          className="hd-button hd-button--small"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Less' : 'How it works'}
        </button>
      </div>
      <p className="sx-card-tagline">{card.tagline}</p>
      {card.note && <p className="sx-card-note">{card.note}</p>}
      <div id={bodyId} hidden={!open} className="sx-card-body">
        {card.origin && <p>{card.origin}</p>}
        <h4 className="sx-card-heading">{card.walkTitle}</h4>
        <ol className="sx-card-list">
          {card.walk.map(step => <li key={step}>{step}</li>)}
        </ol>
        <h4 className="sx-card-heading">{card.gotchasTitle}</h4>
        <ul className="sx-card-list">
          {card.gotchas.map(item => <li key={item}>{item}</li>)}
        </ul>
        {card.story && (
          <>
            <h4 className="sx-card-heading">{card.story.title}</h4>
            <p>{card.story.text}</p>
          </>
        )}
        {card.spec && (
          <p className="sx-card-spec">
            Specification:{' '}
            <a href={card.spec.url} target="_blank" rel="noopener noreferrer">{card.spec.label}</a>
          </p>
        )}
      </div>
    </section>
  )
}

export default FormatCard
