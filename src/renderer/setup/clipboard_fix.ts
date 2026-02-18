// On Linux/Wayland, Electron keeps clipboard data "live" as the XWayland clipboard owner.
// This causes other apps to hang or crash when pasting, because they request the clipboard
// content from Electron and the response is slow or never comes.
//
// Fix: intercept all copy events and hand off the text to wl-copy, which registers the data
// with the Wayland compositor's clipboard daemon independently of the Electron process.

const electronAPI = (window as any).electronAPI

if (electronAPI) {
  document.addEventListener(
    'copy',
    (e) => {
      const selectedText = window.getSelection()?.toString()
      if (selectedText) {
        e.preventDefault()
        electronAPI.invoke('clipboard-write', selectedText)
      }
    },
    true // capture phase so it runs before other handlers
  )
}
