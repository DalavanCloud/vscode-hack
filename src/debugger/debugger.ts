/**
 * @file Hack debug adapter for VS Code.
 * Connects to built-in HHVM debugger (hphpd) on a remote server (or localhost).
 */

import { readFileSync } from 'fs';
import * as net from 'net';
import { Breakpoint, DebugSession, Handles, InitializedEvent, OutputEvent, Scope, StoppedEvent, TerminatedEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { CmdBreak } from './CmdBreak';
import { CmdContinue } from './CmdContinue';
import { CmdInterrupt } from './CmdInterrupt';
import { CmdMachine } from './CmdMachine';
import { CmdSignal, Signal } from './CmdSignal';
import { CmdStep } from './CmdStep';
import * as CommandFactory from './CommandFactory';
import { BindState, BreakPointInfo, BreakPointState, CommandType, InterruptType, SandboxInfo } from './DebuggerBase';
import { DebuggerBufferReader, DebuggerBufferWriter } from './DebuggerBuffer';
import { DebuggerCommand } from './DebuggerCommand';

/**
 * This interface should always match the debugger config schema found in the vscode-hack extension manifest.
 */
// tslint:disable-next-line:interface-name
export interface AttachRequestArguments extends DebugProtocol.LaunchRequestArguments {
    host: string;
    port?: number;
    user: string;
    sandbox: string;
    stopOnRequest: boolean;
}

class HhvmDebugSession extends DebugSession {

    private client: net.Socket;

    // maps from sourceFile to array of Breakpoints
    private breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();

    private variableHandles = new Handles<string>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
    public constructor() {
        super();

        // this debugger uses one-based lines and columns
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
    }

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());

        // This debug adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;

        // make VS Code to use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;

        // make VS Code to show a 'step back' button
        response.body.supportsStepBack = false;

        this.sendResponse(response);
    }

    // tslint:disable-next-line:max-func-body-length
    protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {
        // open a socket connection to hhvm server
        this.client = net.connect({ port: args.port, host: args.host }, () => {
            console.log('Connected...');
        });

        let attached = false;
        let interrupted = false;
        let needInterrupt = false;

        this.client.on('data', data => {
            console.log('Received: ' + data.toString('hex'));
            const debuggerData = new DebuggerBufferReader(data);
            const cmd: DebuggerCommand = CommandFactory.create(debuggerData);
            switch (cmd.cmdType) {
                case CommandType.KindOfInterrupt:
                    interrupted = true;
                    const interruptCmd = <CmdInterrupt>cmd;
                    switch (interruptCmd.interrupt) {
                        case InterruptType.SessionStarted:
                            if (!attached) {
                                // this is the initial interrupt when we successfuly connect to the target machine
                                // now attach to sandbox of choice and send over saved breakpoints
                                const user: string = args.user;
                                const sandbox: string = args.sandbox;
                                const sendCmd = new CmdMachine('attach', [new SandboxInfo(user, sandbox)], false);
                                const sendBuffer = new DebuggerBufferWriter();
                                sendCmd.send(sendBuffer);
                                console.log('Sent: ' + sendBuffer.getBuffer().toString('hex'));
                                this.client.write(sendBuffer.getBuffer(), () => {
                                    interrupted = false;
                                });
                            }
                            break;
                        case InterruptType.SessionEnded:
                            // handle disconnection
                            break;
                        case InterruptType.RequestStarted:
                            // new web request received
                            console.log('Yay!');
                            const stepCmd = new CmdStep('', 1, false);
                            const sendBuffer = new DebuggerBufferWriter();
                            stepCmd.send(sendBuffer);
                            console.log('Sent: ' + sendBuffer.getBuffer().toString('hex'));
                            this.client.write(sendBuffer.getBuffer());
                            break;
                        case InterruptType.BreakPointReached:
                            console.log('Yay!');
                            const stepCmd2 = new CmdStep('', 1, false);
                            const sendBuffer2 = new DebuggerBufferWriter();
                            stepCmd2.send(sendBuffer2);
                            console.log('Sent: ' + sendBuffer2.getBuffer().toString('hex'));
                            this.client.write(sendBuffer2.getBuffer());
                            break;
                        default:
                            break;
                    }
                    break;
                case CommandType.KindOfMachine:
                    const machineCmd = <CmdMachine>cmd;
                    if (machineCmd.succeed) {
                        attached = true;
                        // if on request breakpoint is enabled, send over breakpoint, as well as all others currently selected
                        const breakCmd = new CmdBreak('update', [new BreakPointInfo(BreakPointState.Always, BindState.KnownToBeValid, InterruptType.RequestStarted)]);
                        let sendBuffer = new DebuggerBufferWriter();
                        breakCmd.send(sendBuffer);
                        console.log('Sent: ' + sendBuffer.getBuffer().toString('hex'));
                        this.client.write(sendBuffer.getBuffer());
                        interrupted = false;
                    }
                    break;
                case CommandType.KindOfBreak:
                    const breakCmd = <CmdBreak>cmd;
                    // add breakpoint to internal list and continue execution
                    const continueCmd = new CmdContinue('', 1, false);
                    let sendBuffer = new DebuggerBufferWriter();
                    sendBuffer = new DebuggerBufferWriter();
                    continueCmd.send(sendBuffer);
                    console.log('Sent: ' + sendBuffer.getBuffer().toString('hex'));
                    this.client.write(sendBuffer.getBuffer());
                    break;
                case CommandType.KindOfSignal:
                    const signalCmd = <CmdSignal>cmd;
                    if (signalCmd.signal === Signal.SignalNone) {
                        if (needInterrupt) {
                            signalCmd.signal = Signal.SignalBreak;
                            needInterrupt = false;
                        }
                        const sendBuffer = new DebuggerBufferWriter();
                        signalCmd.send(sendBuffer);
                        console.log('Sent: ' + sendBuffer.getBuffer().toString('hex'));
                        this.client.write(sendBuffer.getBuffer());
                    }
                    break;
                default:
                    break;
            }
        });

        this.client.on('close', () => {
            console.log('Connection closed');
        });

        this.client.on('timeout', () => {
            console.log('Timeout');
            this.client.destroy();
        });

        this.client.on('error', error => {
            console.log('error: ' + error);
        });

    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: AttachRequestArguments): void {
        // we stop on the first line
        this.sendEvent(new StoppedEvent('entry', 0));
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

        const path = args.source.path;
        const clientLines = args.breakpoints;

        // read file contents into array for direct access
        const lines = readFileSync(path).toString().split('\n');

        const breakpoints: Breakpoint[] = [];

        // verify breakpoint locations
        /*for (let i = 0; i < clientLines.length; i += 1) {
            let l = this.convertClientLineToDebugger(clientLines[i]);
            let verified = false;
            if (l < lines.length) {
                const line = lines[l].trim();
                // if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
                if (line.length === 0 || line.indexOf('+') === 0) {
                    l += 1;
                }
                // if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
                if (line.indexOf('-') === 0) {
                    l -= 1;
                }
                // don't set 'verified' to true if the line contains the word 'lazy'
                // in this case the breakpoint will be verified 'lazy' after hitting it once.
                if (line.indexOf('lazy') < 0) {
                    verified = true;    // this breakpoint has been validated
                }
            }
            const bp = <DebugProtocol.Breakpoint>new Breakpoint(verified, this.convertDebuggerLineToClient(l));
            bp.id = this.breakpointId += 1;
            breakpoints.push(bp);
        }*/
        this.breakPoints.set(path, breakpoints);

        // send back the actual breakpoint positions
        response.body = {
            breakpoints: breakpoints
        };
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

        // return the default thread
        /*response.body = {
            threads: [
                new Thread(MockDebugSession.THREAD_ID, 'thread 1')
            ]
        };*/
        this.sendResponse(response);
    }

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

        /*const words = this.sourceLines[this._currentLine].trim().split(/\s+/);

        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : words.length - startFrame;
        const endFrame = Math.min(startFrame + maxLevels, words.length);

        const frames: StackFrame[] = [];
        // every word of the current line becomes a stack frame.
        for (let i = startFrame; i < endFrame; i += 1) {
            const name = words[i];	// use a word of the line as the stackframe name
            frames.push(new StackFrame(
                i,
                `${name}(${i})`,
                new Source(basename(this.sourceFile), this.convertDebuggerPathToClient(this.sourceFile)),
                this.convertDebuggerLineToClient(this._currentLine), 0));
        }
        response.body = {
            stackFrames: frames,
            totalFrames: words.length
        };*/
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

        const frameReference = args.frameId;
        const scopes: Scope[] = [];
        scopes.push(new Scope('Local', this.variableHandles.create('local_' + frameReference), false));
        scopes.push(new Scope('Closure', this.variableHandles.create('closure_' + frameReference), false));
        scopes.push(new Scope('Global', this.variableHandles.create('global_' + frameReference), true));

        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

        const variables = [];
        const id = this.variableHandles.get(args.variablesReference);
        if (id != null) {
            variables.push({
                name: id + '_i',
                type: 'integer',
                value: '123',
                variablesReference: 0
            });
            variables.push({
                name: id + '_f',
                type: 'float',
                value: '3.14',
                variablesReference: 0
            });
            variables.push({
                name: id + '_s',
                type: 'string',
                value: 'hello world',
                variablesReference: 0
            });
            variables.push({
                name: id + '_o',
                type: 'object',
                value: 'Object',
                variablesReference: this.variableHandles.create('object_')
            });
        }

        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {

        /*for (let ln = this._currentLine + 1; ln < this.sourceLines.length; ln += 1) {
            if (this.fireEventsForLine(response, ln)) {
                return;
            }
        }*/
        this.sendResponse(response);
        // no more lines: run to end
        this.sendEvent(new TerminatedEvent());
    }

    protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {

        /*for (let ln = this._currentLine - 1; ln >= 0; ln -= 1) {
            if (this.fireEventsForLine(response, ln)) {
                return;
            }
        }
        this.sendResponse(response);
        // no more lines: stop at first line
        this._currentLine = 0;
        this.sendEvent(new StoppedEvent('entry', MockDebugSession.THREAD_ID));
        */
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {

        /*for (let ln = this._currentLine + 1; ln < this.sourceLines.length; ln += 1) {
            if (this.fireStepEvent(response, ln)) {
                return;
            }
        }
        */
        this.sendResponse(response);
        // no more lines: run to end
        this.sendEvent(new TerminatedEvent());
    }

    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {

        /*for (let ln = this._currentLine - 1; ln >= 0; ln -= 1) {
            if (this.fireStepEvent(response, ln)) {
                return;
            }
        }
        this.sendResponse(response);
        // no more lines: stop at first line
        this._currentLine = 0;
        this.sendEvent(new StoppedEvent('entry', MockDebugSession.THREAD_ID));
        */
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

        response.body = {
            result: `evaluate(context: '${args.context}', '${args.expression}')`,
            variablesReference: 0
        };
        this.sendResponse(response);
    }

    //---- some helpers

	/**
	 * Fire StoppedEvent if line is not empty.
	 */
    private fireStepEvent(response: DebugProtocol.Response, ln: number): boolean {

        /*if (this.sourceLines[ln].trim().length > 0) {	// non-empty line
            this._currentLine = ln;
            this.sendResponse(response);
            this.sendEvent(new StoppedEvent('step', MockDebugSession.THREAD_ID));
            return true;
        }
        */
        return false;

    }

	/**
	 * Fire StoppedEvent if line has a breakpoint or the word 'exception' is found.
	 */
    private fireEventsForLine(response: DebugProtocol.Response, ln: number): boolean {

        // find the breakpoints for the current source file
        /*const breakpoints = this.breakPoints.get(this.sourceFile);
        if (breakpoints) {
            const bps = breakpoints.filter(bp => bp.line === this.convertDebuggerLineToClient(ln));
            if (bps.length > 0) {
                this._currentLine = ln;

                // 'continue' request finished
                this.sendResponse(response);

                // send 'stopped' event
                this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.THREAD_ID));

                // the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
                // if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
                if (!bps[0].verified) {
                    bps[0].verified = true;
                    this.sendEvent(new BreakpointEvent('update', bps[0]));
                }
                return true;
            }
        }

        // if word 'exception' found in source -> throw exception
        if (this.sourceLines[ln].indexOf('exception') >= 0) {
            this._currentLine = ln;
            this.sendResponse(response);
            this.sendEvent(new StoppedEvent('exception', HhvmDebugSession.THREAD_ID));
            this.log('exception in line', ln);
            return true;
        }*/

        return false;
    }

    private log(msg: string, line: number) {
        const e = new OutputEvent(`${msg}: ${line}\n`);
        (<DebugProtocol.OutputEvent>e).body.variablesReference = this.variableHandles.create('args');
        this.sendEvent(e);	// print current line on debug console
    }
}

DebugSession.run(HhvmDebugSession);