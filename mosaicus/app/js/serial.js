// Mosaicus — collegamento con Arduino tramite Web Serial API (Chrome/Edge su computer).
// Stessa interfaccia del simulatore: open(), write(cmd), close(), onLine(cb), onClose(cb).

export const serialSupported = () => 'serial' in navigator;

export class SerialLink {
  constructor() {
    this.kind = 'arduino';
    this.port = null;
    this.reader = null;
    this._lineCb = () => {};
    this._closeCb = () => {};
    this._keepReading = false;
  }
  onLine(cb) { this._lineCb = cb; }
  onClose(cb) { this._closeCb = cb; }

  async open() {
    // Arduino Uno originali (2341) e cloni con CH340 (1a86) compaiono per primi;
    // senza filtro l'utente vede comunque tutte le porte.
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    this._keepReading = true;
    this._readLoop();
    navigator.serial.addEventListener('disconnect', (e) => {
      if (e.target === this.port) this._handleClose();
    });
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    let buf = '';
    while (this.port && this.port.readable && this._keepReading) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '').trim();
            buf = buf.slice(idx + 1);
            if (line) this._lineCb(line);
          }
          if (buf.length > 4096) buf = ''; // protezione da dati senza a capo
        }
      } catch (err) {
        console.warn('Errore di lettura seriale', err);
        break;
      } finally {
        try { this.reader.releaseLock(); } catch { /* già rilasciato */ }
      }
    }
    this._handleClose();
  }

  async write(text) {
    if (!this.port || !this.port.writable) return;
    const w = this.port.writable.getWriter();
    try { await w.write(new TextEncoder().encode(text + '\n')); } finally { w.releaseLock(); }
  }

  async close() {
    this._keepReading = false;
    try { await this.reader?.cancel(); } catch { /* ignora */ }
    try { await this.port?.close(); } catch { /* ignora */ }
    this._handleClose();
  }

  _handleClose() {
    if (!this.port) return;
    this.port = null;
    this._closeCb();
  }
}
