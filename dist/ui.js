(function () {
  "use strict";

  const CSS = `
:host { display: inline-flex; align-items: center; justify-content: center; }
.mic-btn {
  width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  background: var(--surface, rgba(255, 255, 255, 0.05)); color: var(--text-dim, #94a3b8);
  display: grid; place-items: center; cursor: pointer; transition: all 0.15s ease;
}
.mic-btn:hover { background: var(--surface-hover, rgba(255, 255, 255, 0.1)); color: var(--accent, #6ea8fe); }
.mic-btn.recording {
  background: rgba(239, 68, 68, 0.2); border-color: #ef4444; color: #ef4444; animation: pulse 1s infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
`;

  class LocarynDictaphoneBtn extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this.isRecording = false;
    }
    connectedCallback() { this.render(); }

    toggleRecord() {
      this.isRecording = !this.isRecording;
      this.render();
      if (!this.isRecording) {
        const bridge = window.locaryn || window.LocarynPluginAPI;
        if (bridge && bridge.insertChatText) {
          bridge.insertChatText(" [Message dicté vocalement] ");
        }
      }
    }

    render() {
      this.shadowRoot.innerHTML = `
        <style>${CSS}</style>
        <button type="button" class="mic-btn ${this.isRecording ? "recording" : ""}" title="${this.isRecording ? "Arrêter la dictée" : "Dicter un message"}">
          ${this.isRecording ? "🔴" : "🎙️"}
        </button>
      `;
      const btn = this.shadowRoot.querySelector("button");
      if (btn) btn.addEventListener("click", () => this.toggleRecord());
    }
  }

  if (!customElements.get("locaryn-dictaphone-btn")) {
    customElements.define("locaryn-dictaphone-btn", LocarynDictaphoneBtn);
  }
})();
