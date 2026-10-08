import { Component, type ReactNode } from 'react';
/** A panel failure leaves the editor store and saving session mounted. */
export class PanelBoundary extends Component<{ children: ReactNode; retry?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="library-empty"><p>此面板加载失败，画布和草稿仍保留。</p><button className="secondary" onClick={() => { this.props.retry?.(); this.setState({ failed: false }); }}>重试面板</button></div> : this.props.children; }
}
