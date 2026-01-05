import { useState } from 'react'

export default function Auth({ onLogin, onRegister, isReady }) {
  const [email, setEmail] = useState("")
  const [pass, setPass] = useState("")

  return (
    <div className="card">
      <h2>Secure Vault Access</h2>
      <p>End-to-End Encrypted Image Search</p>
      
      <div style={{ marginTop: '1.5rem' }}>
        <input placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} />
        <input type="password" placeholder="Password" value={pass} onChange={e=>setPass(e.target.value)} />
        
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button onClick={() => onLogin(email, pass)} disabled={!isReady}>Login</button>
          <button className="secondary" onClick={() => onRegister(email, pass)} disabled={!isReady}>Register</button>
        </div>
      </div>
    </div>
  )
}