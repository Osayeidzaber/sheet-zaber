import { ImageResponse } from "next/og"

export const alt = "Sheet Zaber: publish a Google Sheets tab as a REST API"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function OpengraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#000", color: "#f2f2f2", padding: 64 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: "#8a8a8a", borderTop: "1px solid #3a3a3a", paddingTop: 20 }}>
        <span>Sheet Zaber</span>
        <span>Private · Invitation only</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", fontSize: 112, fontWeight: 800, letterSpacing: -5, lineHeight: 1 }}>
        <span>Publish a sheet</span>
        <span>tab as an API.</span>
      </div>
    </div>,
    size
  )
}
