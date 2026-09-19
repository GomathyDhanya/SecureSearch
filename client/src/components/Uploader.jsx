export default function Uploader({ onUpload }) {
  const handleChange = async e => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return

    await onUpload(files)

    // Allow selecting the same file(s) again later.
    e.target.value = ''
  }

  return (
    <div className="card" style={{ borderLeft: '4px solid #2563eb' }}>
      <h2>Upload Encrypted Photos</h2>
      <p>
        Photos are embedded and encrypted locally. Up to 8 embeddings are packed
        into each CKKS ciphertext before upload.
      </p>

      <input
        type="file"
        accept="image/*"
        multiple
        onChange={handleChange}
      />
    </div>
  )
}
