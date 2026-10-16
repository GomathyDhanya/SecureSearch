import { useState } from 'react'
import { useSecureSystem } from './hooks/useSecureSystem'
import ResultsGrid from './components/ResultsGrid'
const ms = value => `${Math.round(value)} ms`
export default function App() {
  const system = useSecureSystem()
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [vaultKey, setVaultKey] = useState('')
  const [query, setQuery] = useState(''), [group, setGroup] = useState(0), [nprobe, setNprobe] = useState(36)
  const [adaptive, setAdaptive] = useState(false)
  const [privateMode, setPrivateMode] = useState(false), [coverPolicy, setCoverPolicy] = useState('dp'), [epsilon, setEpsilon] = useState(2), [privateBudget, setPrivateBudget] = useState(4), [requiredLeaves, setRequiredLeaves] = useState(1)
  const [compare, setCompare] = useState(false), [results, setResults] = useState([])
  const [bufferedVault, setBufferedVault] = useState(false)
  const disabled = !system.isReady || system.busy
  async function search(synthetic) {
    const found = await system.search({ ...(synthetic ? { group } : { text: query }), nprobe, compare,
      adaptive: adaptive && !opaqueBuffer, privateMode: privateMode && !opaqueBuffer,
      coverPolicy, epsilon, privateBudget, requiredLeaves })
    if (found) setResults(found)
  }
  function downloadRecovery() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(system.recovery, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = 'securelens-vault-key.json'; a.click(); URL.revokeObjectURL(url)
  }
  const syntheticVault = system.stats?.embeddingSpace === 'synthetic-fixture-v1'
  const opaqueBuffer = system.stats?.format === 'buffered-private-centroid-tree-experiment-v1'
  const effectivePrivate = privateMode && !opaqueBuffer
  const metrics = system.metrics
  return <main className="container">
    <header className="header"><div><span className="eyebrow">ENCRYPTED SEARCH / RESEARCH PROTOTYPE</span><h1>SecureLens</h1><p>Private vectors. Server-side scoring. A smaller search space.</p></div>
      {system.user && <button className="secondary" disabled={system.busy} onClick={() => window.location.reload()}>Lock vault</button>}</header>
    <div className={`status ${system.busy ? 'working' : ''}`} role="status">{system.busy ? '◌' : '●'} {system.status}</div>
    {!system.user ? <section className="card">
      <h2>Open your encrypted collection</h2><p>The account password signs you in. A separate random vault key decrypts your data and never leaves your device.</p>
      <label>Email<input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label>Account password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <label>Vault key <span className="muted">(existing accounts only)</span><input type="password" autoComplete="off" value={vaultKey} onChange={e => setVaultKey(e.target.value)} /></label>
      <label className="checkbox"><input type="checkbox" checked={bufferedVault} onChange={e => setBufferedVault(e.target.checked)} /> Experimental opaque insert buffer for new vaults</label>
      {bufferedVault && <p className="muted">New inserts stay unclustered until 500 images accumulate. Searches scan every pending image; the server still sees IDs, timing, selected sealed groups, and result fetches. The client clusters records at each seal.</p>}
      <div className="actions"><button disabled={disabled} onClick={() => system.login(email, password, vaultKey)}>Unlock</button><button className="secondary" disabled={disabled} onClick={() => system.register(email, password, { buffered: bufferedVault })}>Create vault</button></div>
      <div className="demo-entry"><h3>Try a working example</h3><p>Create a local vault with 256 synthetic 512-D vectors. Encryption and server computation are real; the example cards are generated fixtures.</p>
        <button disabled={disabled} onClick={system.createDemo}>Run synthetic demo</button></div>
    </section> : <>
      {system.recovery && <section className="recovery"><div><strong>Save your vault key</strong><p>You need it to unlock this collection on another device. It cannot be recovered from your account password.</p></div><button onClick={downloadRecovery}>Download recovery file</button></section>}
      <div className="stats"><article><strong>{system.stats?.count ?? 0}</strong><span>encrypted vectors</span></article><article><strong>{system.stats?.leaves ?? 0}</strong><span>coarse groups</span></article><article><strong>{((system.stats?.routingBytes ?? 0) / 1024).toFixed(1)} KiB</strong><span>serialized client routing index</span></article></div>
      {opaqueBuffer && <p className="muted">Opaque buffer active: {system.stats.pendingCount} pending images are scored on every search. This hides pre-seal cluster placement from insert metadata only; it does not hide result or sealed-group access.</p>}
      <section className="card"><h2>Add your images</h2><p>CLIP runs locally when you upload real images. The hierarchy grows and splits during insertion; only encrypted vectors, images, and index snapshots are uploaded.</p>
        {syntheticVault && <p className="muted">This vault contains synthetic fixtures. Create a separate vault to upload and search real images.</p>}
        <input aria-label="Upload images" type="file" accept="image/*" multiple disabled={disabled || syntheticVault} onChange={async e => { await system.uploadImages(e.target.files); e.target.value = '' }} />
      </section>
      <section className="card"><div className="section-top"><h2>Search the collection</h2>{!effectivePrivate && <label className="inline">Initial / fixed groups<select aria-label="Initial / fixed groups" value={nprobe} onChange={e => setNprobe(Number(e.target.value))}>{[1, 2, 4, 8, 16, 32, 36, 40, 64, 128].map(n => <option key={n}>{n}</option>)}</select></label>}</div>
        <div className="actions"><input aria-label="Describe your photo" placeholder="Describe your photo…" value={query} onChange={e => setQuery(e.target.value)} /><button disabled={disabled || syntheticVault || !query.trim()} onClick={() => search(false)}>Search images</button></div>
        <div className="synthetic-controls"><label className="inline">Synthetic query<select aria-label="Synthetic query" value={group} onChange={e => setGroup(Number(e.target.value))}>{Array.from({ length: 16 }, (_, i) => <option value={i} key={i}>Group {i + 1}</option>)}</select></label><button className="secondary" disabled={disabled || !syntheticVault} onClick={() => search(true)}>Search demo vectors</button></div>
        <label className="checkbox"><input type="checkbox" checked={privateMode && !opaqueBuffer} disabled={opaqueBuffer} onChange={e => setPrivateMode(e.target.checked)} /> Cover selected groups and fetch all images in them</label>
        {effectivePrivate && <><div className="actions"><label>Cover policy<select aria-label="Cover policy" value={coverPolicy} onChange={e => setCoverPolicy(e.target.value)}><option value="dp">ε-private randomized cover</option><option value="decoy">Best groups + random decoys</option></select></label><label>Cover groups<select aria-label="Cover groups" value={privateBudget} onChange={e => { const value = Number(e.target.value); setPrivateBudget(value); setRequiredLeaves(Math.min(requiredLeaves, value)) }}>{[1, 2, 4, 8, 16].map(value => <option key={value}>{value}</option>)}</select></label></div>
          {coverPolicy === 'dp' ? <><p className="muted">Single-query ε-local differential privacy for the selected group set, assuming a fixed vault and request time. Repeated searches add their ε values. This sends all encrypted images in selected groups. It does not hide your account, collection structure, or activity times. In the measured COCO 5k study, ε=2 with four groups found the official image at rank 1 for only 1.78% of captions.</p><label>Privacy ε<select aria-label="Privacy epsilon" value={epsilon} onChange={e => setEpsilon(Number(e.target.value))}>{[0, 1, 2, 4, 8].map(value => <option key={value}>{value}</option>)}</select></label></>
            : <><p className="muted">Always include the best routing groups, then add random decoys. On COCO 5k, best 1 + 3 decoys reached 8.64% image Recall@1. The server knows the true best group is in the visible cover. There is no finite ε-DP guarantee; repeating a query with fresh decoys can expose the group by set intersection.</p><label>Guaranteed best groups<select aria-label="Guaranteed best groups" value={requiredLeaves} onChange={e => setRequiredLeaves(Number(e.target.value))}>{[1, 2, 4, 8, 16].filter(value => value <= privateBudget).map(value => <option key={value}>{value}</option>)}</select></label></>}</>}
        {!effectivePrivate && <><p className="muted">Direct routing exposes selected groups and the fetched result ID to the server. {opaqueBuffer ? 'On all COCO val2017 captions, the buffered index reached 95.03% exact-neighbor Recall@10 at 36 probes while scoring 21.86% of images.' : 'On COCO 5k, 32 groups reached 95.98% ANN Recall@10 and 21.86% official image Recall@1, versus 22.36% for exhaustive scoring on the same model.'}</p><label className="checkbox"><input type="checkbox" checked={adaptive && !opaqueBuffer} disabled={opaqueBuffer} onChange={e => setAdaptive(e.target.checked)} /> Adaptive bounds: expand until unseen groups cannot improve the result (conditional on numeric tolerance)</label>
        <label className="checkbox"><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} /> Also run exhaustive encrypted search to compare recall and cost</label></>}
        {metrics && <div className="metrics"><h3>Measured in this session</h3>{metrics.privacy && <p>{metrics.privacy.policy === 'decoy' ? `Decoy cover: ${metrics.privacy.required} guaranteed best groups in ${metrics.privacy.budget}/${metrics.privacy.totalLeaves} visible groups. The server knows the best group is in this set; no ε-DP guarantee.` : `Private cover: ε=${metrics.privacy.epsilon} · ${metrics.privacy.budget}/${metrics.privacy.totalLeaves} groups · preferred group inclusion probability ${(100 * metrics.privacy.preferredIncludedProbability).toFixed(1)}%. This is a per-query bound on the server-visible search transcript under the stated assumptions.`}</p>}{metrics.audit && <p>Stopping: <strong>{metrics.audit.status}</strong>{metrics.audit.visitedLeaves !== undefined && <> · {metrics.audit.visitedLeaves}/{metrics.audit.totalLeaves} groups · {metrics.audit.rounds} rounds</>} · conditional score regret ≤ {metrics.audit.scoreRegretBound?.toFixed(4) ?? "unknown"}. Assumed CKKS error ≤ {metrics.audit.scoreError}. This is not a proof of exact ranking.</p>}<table><thead><tr><th>Metric</th><th>Clustered ANN</th><th>Exhaustive</th></tr></thead><tbody>
          <tr><td>Candidates scored on server</td><td>{metrics.candidateCount}</td><td>{system.comparison?.candidateCount ?? '—'}</td></tr>
          <tr><td>Encrypted server computation</td><td>{ms(metrics.computeMs)}</td><td>{system.comparison ? ms(system.comparison.computeMs) : '—'}</td></tr>
          <tr><td>Client routing</td><td>{ms(metrics.routingMs)}</td><td>0 ms</td></tr>
          <tr><td>Client decrypt + scalar ranking</td><td>{ms(metrics.clientDecryptRankMs)}</td><td>{system.comparison ? ms(system.comparison.clientDecryptRankMs) : '—'}</td></tr>
          <tr><td>Search through score ranking</td><td>{ms(metrics.searchMs)}</td><td>{system.comparison ? ms(system.comparison.searchMs) : '—'}</td></tr>
          <tr><td>Response ciphertexts</td><td>{metrics.resultCiphertexts}</td><td>{system.comparison?.resultCiphertexts ?? '—'}</td></tr>
          <tr><td>Response including cover images</td><td>{(metrics.responseBytes / 1024).toFixed(1)} KiB</td><td>{system.comparison ? `${(system.comparison.responseBytes / 1024).toFixed(1)} KiB` : '—'}</td></tr>
          <tr><td>Top-1 agreement with exhaustive encrypted search</td><td>{system.comparison ? `${(system.comparison.recall * 100).toFixed(1)}%` : '—'}</td><td>{system.comparison ? '100%' : '—'}</td></tr>
        </tbody></table><p className="muted">Single-query timings include warm-up effects. Final scalar ranking remains on the client. No candidate embeddings are downloaded during search.</p></div>}
        <ResultsGrid results={results} />
      </section>
    </>}
    <section className="privacy"><strong>What the server can observe</strong><p>Account identity, storage sizes, selected coarse groups, update locations, timing, and fetched image IDs. In ordinary adaptive mode it also sees round counts and stopping behavior. Both cover policies remove per-result image fetches; only the ε-private policy has the stated selected-group DP guarantee. Decoy cover always includes the best groups and exposes that fact. Centroids, vectors, query contents, images, and numeric scores stay encrypted. This prototype assumes an honest-but-curious server and trusted client code.</p></section>
    {system.logs.length > 0 && <details className="card"><summary>Activity log</summary><div className="logs">{system.logs.map((entry, i) => <div key={i}>{entry}</div>)}</div></details>}
  </main>
}
