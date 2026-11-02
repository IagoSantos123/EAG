// Avisos sonoros curtos (cozinha: pedido novo; painel da TV: senha pronta), sem arquivos de áudio.
function tone(context, frequency, start, duration, volume) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.connect(gain); gain.connect(context.destination);
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, context.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + start + duration);
  oscillator.start(context.currentTime + start);
  oscillator.stop(context.currentTime + start + duration);
  return oscillator;
}

export function beep() {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    tone(context, 880, 0, 0.6, 0.18).onended = () => context.close();
  } catch { /* navegador sem áudio */ }
}

// Dois toques subindo, mais alto: chama a atenção de quem está no salão.
export function chime() {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    tone(context, 660, 0, 0.5, 0.3);
    tone(context, 990, 0.25, 0.7, 0.3).onended = () => context.close();
  } catch { /* navegador sem áudio */ }
}
