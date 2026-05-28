'use client'

import { useState } from 'react'
import { inputCls } from '../lib/utils'

interface AuthModalProps {
  loading: boolean
  onClose: () => void
  onAuth: (key?: string) => void
}

export function AuthModal({ loading, onClose, onAuth }: AuthModalProps) {
  const [authKey, setAuthKey] = useState('')

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-aeon-panel border border-[rgba(250,250,250,0.10)] w-full max-w-sm mx-4 p-[var(--space-lg)] shadow-2xl">
        <div className="flex items-center justify-between mb-[var(--space-sm)]">
          <h2 className="font-display text-xl">Authenticate</h2>
          <button onClick={onClose} className="text-primary-35 hover:text-primary-100 text-lg">&times;</button>
        </div>
        <p className="text-xs text-primary-50 font-mono mb-[var(--space-md)]">
          Use an Anthropic API key for pay-as-you-go runs, or connect a Claude subscription token.
        </p>
        <div className="text-[11px] font-mono uppercase tracking-[1px] text-primary-35 mb-2">Anthropic API key</div>
        <input type="password" value={authKey} onChange={(e) => setAuthKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && authKey.trim() && onAuth(authKey.trim())} placeholder="sk-ant-..." autoFocus className={`${inputCls} mb-[var(--space-md)]`} />
        <button onClick={() => onAuth(authKey.trim())} disabled={!authKey.trim() || loading} className="w-full bg-aeon-fg text-aeon-bg text-sm py-3 font-mono uppercase tracking-[2px] hover:opacity-90 transition-opacity disabled:opacity-50">{loading ? '...' : 'Save API Key'}</button>
        <div className="my-[var(--space-md)] border-t border-[rgba(250,250,250,0.10)]" />
        <button onClick={() => onAuth()} disabled={loading} className="w-full bg-aeon-panel text-aeon-fg border border-[rgba(250,250,250,0.14)] text-sm py-3 font-mono uppercase tracking-[2px] hover:border-eva-orange transition-colors disabled:opacity-50">
          {loading ? '...' : 'Use Claude Subscription'}
        </button>
      </div>
    </div>
  )
}
