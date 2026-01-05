import { useState } from 'react'
import { useSecureSystem } from './hooks/useSecureSystem'
import Auth from './components/Auth'
import Uploader from './components/Uploader'
import ResultsGrid from './components/ResultsGrid'

export default function App() {
  const { isReady, status, user, logs, login, register, uploadImage, searchImages } = useSecureSystem()
  const [results, setResults] = useState([])
  const [query, setQuery] = useState("")

  const handleSearch = async () => {
    const res = await searchImages(query, 4) // Fetch Top 4
    setResults(res)
  }

  return (
    <div className="container">
      <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>SecureLens</h1>
          <div style={{ fontSize: '0.9rem', color: isReady ? '#10b981' : '#f59e0b' }}>● {status}</div>
        </div>
        {user && <button className="secondary" onClick={() => window.location.reload()}>Logout</button>}
      </header>

      {!user ? (
        <Auth onLogin={login} onRegister={register} isReady={isReady} />
      ) : (
        <>
          <Uploader onUpload={uploadImage} />
          
          <div className="card">
            <h2> Secure Search</h2>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <input 
                placeholder="Describe your photo..." 
                value={query} 
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                style={{ marginBottom: 0 }}
              />
              <button onClick={handleSearch}>Search</button>
            </div>
            
            <ResultsGrid results={results} />
          </div>
        </>
      )}

      {/* Terminal Logs */}
      <div className="logs">
        <div style={{ borderBottom: '1px solid #333', paddingBottom: '0.5rem', marginBottom: '0.5rem', color: '#888' }}>System Terminal</div>
        {logs.map((l, i) => <div key={i}>&gt; {l}</div>)}
      </div>
    </div>
  )
}