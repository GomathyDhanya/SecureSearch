export default function Uploader({ onUpload }) {
  return (
    <div className="card" style={{ borderLeft: '4px solid #2563eb' }}>
      <h2>Upload Encrypted Photo</h2>
      <p>Photos are encrypted locally before upload.</p>
      <input type="file" accept="image/*" onChange={(e) => e.target.files[0] && onUpload(e.target.files[0])} />
    </div>
  )
}