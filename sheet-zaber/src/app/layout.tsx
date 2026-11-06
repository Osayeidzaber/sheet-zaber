import type { Metadata, Viewport } from "next"
import { Bricolage_Grotesque, Instrument_Serif, JetBrains_Mono } from "next/font/google"

import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/lib/site"

import "./globals.css"

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
})

const instrument = Instrument_Serif({
  variable: "--font-instrument",
  weight: "400",
  style: ["italic"],
  subsets: ["latin"],
  display: "swap",
})

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  weight: ["400", "500"],
  subsets: ["latin"],
  display: "swap",
})

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: { default: SITE_TITLE, template: "%s | Sheet Zaber" },
  description: SITE_DESCRIPTION,
  authors: [{ name: "Osayeed Zaber" }],
  // Public by default; the (app) layout and /login opt out. Relative, so each page names itself.
  alternates: { canonical: "./" },
  openGraph: { type: "website", siteName: SITE_NAME, title: SITE_TITLE, description: SITE_DESCRIPTION, url: "./", locale: "en_US" },
  twitter: { card: "summary_large_image", title: SITE_TITLE, description: SITE_DESCRIPTION },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large" } },
}

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${bricolage.variable} ${instrument.variable} ${jetbrains.variable} antialiased`}
    >
      <body>{children}</body>
    </html>
  )
}
