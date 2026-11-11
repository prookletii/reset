const input = document.querySelector('#document-input');
const openButton = document.querySelector('#open-document');
const dialog = document.querySelector('#reader-dialog');
const content = document.querySelector('#reader-content');
const fileName = document.querySelector('#reader-file-name');
const fileType = document.querySelector('#reader-file-type');
let activeUrl = null;

openButton.addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (!file) return;
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = URL.createObjectURL(file);
  fileName.textContent = file.name;
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  fileType.textContent = isPdf ? 'PDF · opened locally' : 'EPUB · selected locally';
  content.replaceChildren();
  if (isPdf) {
    const frame = document.createElement('iframe');
    frame.title = `PDF document: ${file.name}`;
    frame.src = activeUrl;
    content.append(frame);
  } else {
    const message = document.createElement('div');
    message.className = 'reader-message';
    const heading = document.createElement('h2');
    heading.textContent = 'Your book is ready for the reader.';
    const paragraph = document.createElement('p');
    paragraph.textContent = 'EPUB chapter rendering is part of the next development phase. The file was selected on this device and has not been uploaded.';
    const detail = document.createElement('p');
    detail.className = 'formats';
    detail.textContent = file.name;
    message.append(heading, paragraph, detail);
    content.append(message);
  }
  dialog.showModal();
  input.value = '';
});

document.querySelector('#close-reader').addEventListener('click', () => dialog.close());
document.querySelector('#fullscreen').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await dialog.requestFullscreen();
    else await document.exitFullscreen();
  } catch { /* Fullscreen may be unavailable in some mobile browsers. */ }
});
dialog.addEventListener('close', () => {
  content.replaceChildren();
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = null;
});
