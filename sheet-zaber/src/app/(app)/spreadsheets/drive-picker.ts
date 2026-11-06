/* Loads Google's Picker on demand, so pages that never open it make no request to Google. */

type PickerResponse = { action: string; docs?: { id: string }[] }

type PickerBuilder = {
  addView(view: unknown): PickerBuilder
  setOAuthToken(token: string): PickerBuilder
  setDeveloperKey(key: string): PickerBuilder
  setAppId(id: string): PickerBuilder
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder
  build(): { setVisible(visible: boolean): void }
}

declare global {
  interface Window {
    gapi?: { load(name: string, callback: () => void): void }
    google?: {
      picker: {
        PickerBuilder: new () => PickerBuilder
        DocsView: new (viewId: unknown) => unknown
        ViewId: { SPREADSHEETS: unknown }
        Action: { PICKED: string; CANCEL: string }
      }
    }
  }
}

export const PICKER_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? ""

function loadPicker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => window.gapi?.load("picker", resolve)
    if (window.gapi) return ready()
    const script = document.createElement("script")
    script.src = "https://apis.google.com/js/api.js"
    script.onload = ready
    script.onerror = () => reject(new Error("The Google Picker could not load."))
    document.head.appendChild(script)
  })
}

/** Resolves with the chosen spreadsheet id, or null when the person cancels. */
export async function pickSpreadsheet(token: string, appId: string): Promise<string | null> {
  await loadPicker()
  const picker = window.google?.picker
  if (!picker) throw new Error("The Google Picker could not load.")
  return new Promise((resolve) => {
    new picker.PickerBuilder()
      .addView(new picker.DocsView(picker.ViewId.SPREADSHEETS))
      .setOAuthToken(token)
      .setDeveloperKey(PICKER_API_KEY)
      .setAppId(appId)
      .setCallback((response) => {
        if (response.action === picker.Action.PICKED) resolve(response.docs?.[0]?.id ?? null)
        else if (response.action === picker.Action.CANCEL) resolve(null)
      })
      .build()
      .setVisible(true)
  })
}
