export default function ResultsGrid({ results }) {
  if (!results || results.length === 0) return null;

  return (
    <div style={{ marginTop: '2rem' }}>
      <h3>Top Matches (Decrypted)</h3>
      <div className="results-grid">
        {results.map((res, i) => (
          <div key={res.id} className="result-card">
            <img src={res.url} alt="Decrypted" className="result-img" />
            <div className="result-info">
              <div>Match #{i + 1}</div>
              <div style={{ fontWeight: 'bold', color: res.score > 0.25 ? '#10b981' : '#f59e0b' }}>
                Score: {res.score.toFixed(4)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}