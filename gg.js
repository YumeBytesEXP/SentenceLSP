class RealLSPClient {
	constructor() {
		this.messageId = 0;
		this.pendingRequests = new Map();
		this.isConnected = false;
		this.serverCapabilities = null;
		this.ws = null;
		this.reconnectAttempts = 0;
		this.maxReconnectAttempts = 5;
	}
	
	// Connect to actual RobloxLsp server
	connect(url = 'ws://localhost:8080/lsp') {
		try {
			this.addLog(`Connecting to LSP server at ${url}...`, 'info');
			
			this.ws = new WebSocket(url);
			
			this.ws.onopen = () => {
				this.isConnected = true;
				this.reconnectAttempts = 0;
				this.updateConnectionStatus(true, 'Connected');
				this.addLog('WebSocket connection established', 'success');
				this.initialize();
			};
			
			this.ws.onmessage = (event) => {
				try {
					const message = JSON.parse(event.data);
					this.handleMessage(message);
				} catch (error) {
					this.addLog(`Failed to parse message: ${error.message}`, 'error');
				}
			};
			
			this.ws.onclose = (event) => {
				this.isConnected = false;
				this.updateConnectionStatus(false, 'Disconnected');
				this.addLog(`Connection closed: ${event.code} - ${event.reason}`, 'error');
				
				// Auto-reconnect
				if (this.reconnectAttempts < this.maxReconnectAttempts) {
					this.reconnectAttempts++;
					const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
					this.addLog(`Reconnecting in ${delay}ms... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'info');
					setTimeout(() => this.connect(url), delay);
				}
			};
			
			this.ws.onerror = (error) => {
				this.addLog(`WebSocket error: ${error.message || 'Unknown error'}`, 'error');
				this.updateConnectionStatus(false, 'Connection error');
			};
			
			return true;
		} catch (error) {
			this.addLog(`Connection failed: ${error.message}`, 'error');
			this.updateConnectionStatus(false, 'Connection failed');
			return false;
		}
	}
	
	sendMessage(message) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.addLog('Cannot send message: connection not ready', 'error');
			return Promise.reject(new Error('Connection not ready'));
		}
		
		const jsonMessage = JSON.stringify(message);
		this.ws.send(jsonMessage);
		
		// Return promise for request/response pattern
		if (message.id !== undefined) {
			return new Promise((resolve, reject) => {
				this.pendingRequests.set(message.id, { resolve, reject, timestamp: Date.now() });
				
				// Timeout after 30 seconds
				setTimeout(() => {
					if (this.pendingRequests.has(message.id)) {
						this.pendingRequests.delete(message.id);
						reject(new Error('Request timeout'));
					}
				}, 30000);
			});
		}
		
		return Promise.resolve();
	}
	
	handleMessage(message) {
		// Handle responses to our requests
		if (message.id && this.pendingRequests.has(message.id)) {
			const request = this.pendingRequests.get(message.id);
			this.pendingRequests.delete(message.id);
			
			if (message.error) {
				request.reject(new Error(message.error.message || 'LSP error'));
			} else {
				request.resolve(message.result);
			}
			return;
		}
		
		// Handle server notifications
		if (message.method) {
			switch (message.method) {
				case 'textDocument/publishDiagnostics':
					this.handleDiagnostics(message.params);
					break;
				case 'window/logMessage':
					this.addLog(message.params.message, this.getLogLevel(message.params.type));
					break;
				case 'window/showMessage':
					showNotification(message.params.message, 3000, message.params.type === 1);
					break;
				default:
					this.addLog(`Unhandled notification: ${message.method}`, 'info');
			}
		}
	}
	
	getLogLevel(type) {
		switch (type) {
			case 1: return 'error';
			case 2: return 'error';
			case 3: return 'info';
			case 4: return 'info';
			default: return 'info';
		}
	}
	
	async initialize() {
		const initParams = {
			jsonrpc: '2.0',
			id: ++this.messageId,
			method: 'initialize',
			params: {
				processId: null,
				clientInfo: {
					name: 'LuaU Web Editor',
					version: '1.0.0'
				},
				rootUri: null,
				capabilities: {
					textDocument: {
						completion: {
							completionItem: {
								snippetSupport: true,
								commitCharactersSupport: true,
								documentationFormat: ['markdown', 'plaintext'],
								deprecatedSupport: true,
								preselectSupport: true
							},
							contextSupport: true
						},
						hover: {
							contentFormat: ['markdown', 'plaintext']
						},
						signatureHelp: {
							signatureInformation: {
								documentationFormat: ['markdown', 'plaintext'],
								parameterInformation: {
									labelOffsetSupport: true
								}
							}
						},
						publishDiagnostics: {
							relatedInformation: true,
							versionSupport: true,
							tagSupport: { valueSet: [1, 2] }
						},
						definition: {
							linkSupport: true
						},
						references: {
							context: { includeDeclaration: true }
						},
						documentFormatting: true,
						documentRangeFormatting: true
					},
					workspace: {
						workspaceFolders: true,
						configuration: true
					}
				},
				trace: 'verbose',
				workspaceFolders: null
			}
		};
		
		try {
			const result = await this.sendMessage(initParams);
			this.serverCapabilities = result.capabilities;
			this.addLog('Server initialized successfully', 'success');
			
			// Send initialized notification
			await this.sendMessage({
				jsonrpc: '2.0',
				method: 'initialized',
				params: {}
			});
			
			lspReady = true;
			showNotification('LSP server ready!');
			this.setupEditorIntegration();
			
		} catch (error) {
			this.addLog(`Initialization failed: ${error.message}`, 'error');
		}
	}
	
	async openDocument(uri, languageId, version, text) {
		if (!this.isConnected) return;
		
		await this.sendMessage({
			jsonrpc: '2.0',
			method: 'textDocument/didOpen',
			params: {
				textDocument: {
					uri,
					languageId,
					version,
					text
				}
			}
		});
	}
	
	async changeDocument(uri, version, changes) {
		if (!this.isConnected) return;
		
		await this.sendMessage({
			jsonrpc: '2.0',
			method: 'textDocument/didChange',
			params: {
				textDocument: { uri, version },
				contentChanges: changes
			}
		});
	}
	
	async getCompletions(uri, position) {
		if (!this.isConnected || !this.serverCapabilities?.completionProvider) {
			return { suggestions: [] };
		}
		
		try {
			const result = await this.sendMessage({
				jsonrpc: '2.0',
				id: ++this.messageId,
				method: 'textDocument/completion',
				params: {
					textDocument: { uri },
					position,
					context: {
						triggerKind: 1 // Invoked
					}
				}
			});
			
			const items = Array.isArray(result) ? result : result?.items || [];
			return {
				suggestions: items.map(item => ({
					label: item.label,
					kind: this.mapCompletionKind(item.kind),
					documentation: item.documentation,
					insertText: item.insertText || item.label,
					insertTextRules: item.insertTextFormat === 2 ? 
						monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : 0,
					range: item.range || {
						startLineNumber: position.line + 1,
						endLineNumber: position.line + 1,
						startColumn: position.character + 1,
						endColumn: position.character + 1
					}
				}))
			};
		} catch (error) {
			this.addLog(`Completion error: ${error.message}`, 'error');
			return { suggestions: [] };
		}
	}
	
	mapCompletionKind(kind) {
		const mapping = {
			1: monaco.languages.CompletionItemKind.Text,
			2: monaco.languages.CompletionItemKind.Method,
			3: monaco.languages.CompletionItemKind.Function,
			4: monaco.languages.CompletionItemKind.Constructor,
			5: monaco.languages.CompletionItemKind.Field,
			6: monaco.languages.CompletionItemKind.Variable,
			7: monaco.languages.CompletionItemKind.Class,
			8: monaco.languages.CompletionItemKind.Interface,
			9: monaco.languages.CompletionItemKind.Module,
			10: monaco.languages.CompletionItemKind.Property,
			11: monaco.languages.CompletionItemKind.Unit,
			12: monaco.languages.CompletionItemKind.Value,
			13: monaco.languages.CompletionItemKind.Enum,
			14: monaco.languages.CompletionItemKind.Keyword,
			15: monaco.languages.CompletionItemKind.Snippet,
			16: monaco.languages.CompletionItemKind.Color,
			17: monaco.languages.CompletionItemKind.File,
			18: monaco.languages.CompletionItemKind.Reference
		};
		return mapping[kind] || monaco.languages.CompletionItemKind.Text;
	}
	
	async getHover(uri, position) {
		if (!this.isConnected || !this.serverCapabilities?.hoverProvider) {
			return null;
		}
		
		try {
			const result = await this.sendMessage({
				jsonrpc: '2.0',
				id: ++this.messageId,
				method: 'textDocument/hover',
				params: {
					textDocument: { uri },
					position
				}
			});
			
			if (!result || !result.contents) return null;
			
			const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
			const markdown = contents.map(content => {
				if (typeof content === 'string') return content;
				return content.value || content;
			}).join('\n\n');
			
			return {
				range: result.range,
				contents: [{ value: markdown }]
			};
		} catch (error) {
			this.addLog(`Hover error: ${error.message}`, 'error');
			return null;
		}
	}
	
	setupEditorIntegration() {
		if (!editor || !editorLoaded) return;
		
		const model = editor.getModel();
		const uri = model.uri.toString();
		
		// Open document with LSP
		this.openDocument(uri, 'lua', 1, model.getValue());
		
		// Track document changes
		let version = 1;
		model.onDidChangeContent((event) => {
			version++;
			const changes = event.changes.map(change => ({
				range: {
					start: {
						line: change.range.startLineNumber - 1,
						character: change.range.startColumn - 1
					},
					end: {
						line: change.range.endLineNumber - 1,
						character: change.range.endColumn - 1
					}
				},
				text: change.text
			}));
			
			this.changeDocument(uri, version, changes);
		});
		
		// Register providers
		monaco.languages.registerCompletionItemProvider('lua', {
			provideCompletionItems: async (model, position) => {
				if (!autoCompletionEnabled) return { suggestions: [] };
				
				const lspPosition = {
					line: position.lineNumber - 1,
					character: position.column - 1
				};
				
				return await this.getCompletions(uri, lspPosition);
			},
			triggerCharacters: ['.', ':', '(', ',']
		});
		
		monaco.languages.registerHoverProvider('lua', {
			provideHover: async (model, position) => {
				if (!hoverInfoEnabled) return null;
				
				const lspPosition = {
					line: position.lineNumber - 1,
					character: position.column - 1
				};
				
				return await this.getHover(uri, lspPosition);
			}
		});
		
		this.addLog('Editor integration complete', 'success');
	}
	
	handleDiagnostics(params) {
		if (!editor || !errorDetectionEnabled) return;
		
		const model = editor.getModel();
		const markers = params.diagnostics.map(diag => ({
			startLineNumber: diag.range.start.line + 1,
			endLineNumber: diag.range.end.line + 1,
			startColumn: diag.range.start.character + 1,
			endColumn: diag.range.end.character + 1,
			message: diag.message,
			severity: diag.severity === 1 ? monaco.MarkerSeverity.Error :
					  diag.severity === 2 ? monaco.MarkerSeverity.Warning :
					  diag.severity === 3 ? monaco.MarkerSeverity.Info :
					  monaco.MarkerSeverity.Hint
		}));
		
		monaco.editor.setModelMarkers(model, 'roblox-lsp', markers);
		
		if (params.diagnostics.length > 0) {
			this.addLog(`Received ${params.diagnostics.length} diagnostic(s)`, 'info');
		}
	}
	
	// Helper methods from original implementation
	updateConnectionStatus(connected, message) {
		this.isConnected = connected;
		const badge = document.getElementById('lspBadge');
		const badgeText = document.getElementById('lspBadgeText');
		const indicator = document.getElementById('lspIndicator');
		const statusText = document.getElementById('lspStatusText');
		
		if (badge && badgeText) {
			if (connected) {
				badge.classList.remove('disconnected');
				badgeText.textContent = 'LSP Ready';
			} else {
				badge.classList.add('disconnected');
				badgeText.textContent = 'LSP Error';
			}
		}
		
		if (indicator && statusText) {
			if (connected) {
				indicator.classList.remove('disconnected');
				statusText.textContent = message || 'Connected';
			} else {
				indicator.classList.add('disconnected');
				statusText.textContent = message || 'Disconnected';
			}
		}
	}
	
	addLog(message, type = 'info') {
		const logsContainer = document.getElementById('lspLogs');
		if (!logsContainer) return;
		
		const timestamp = new Date().toLocaleTimeString();
		const logEntry = document.createElement('div');
		logEntry.className = `log-entry ${type}`;
		logEntry.textContent = `[${timestamp}] ${message}`;
		
		logsContainer.appendChild(logEntry);
		logsContainer.scrollTop = logsContainer.scrollHeight;
		
		// Keep only last 50 entries
		while (logsContainer.children.length > 50) {
			logsContainer.removeChild(logsContainer.firstChild);
		}
	}
}