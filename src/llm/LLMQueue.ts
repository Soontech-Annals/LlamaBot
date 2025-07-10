import got from "got";
import { LLMRequest } from "./LLMRequest.js";
import { LLMResponseFuture as LLMResponseFuture } from "./LLMResponseFuture.js";
import { LLMRequestAndPromise } from "./LLMRequestAndPromise.js";
import { LLMResponse } from "./LLMResponse.js";


const URL = 'http://localhost:8000/generate'

/**
 * Manages a queue of LLM requests.
 */
export class LLMQueue {
    /**
     * The queue of LLM requests.
     */
    private _llmQueue: LLMRequestAndPromise[] = [];

    private _processing: boolean = false;

    constructor() {
        this._llmQueue = [];
    }
    
    /**
     * Adds a new request to the queue and processes it if the queue is empty.
     * @param request The LLMRequest to add to the queue.
     */
    public addRequest(request: LLMRequest): LLMResponseFuture {
        // Validate the request's prompt input
        const validation = request.prompt.validateInput();
        if (validation instanceof Error) {
            throw validation;
        }

        const promise = new Promise<LLMResponse>((resolve, reject) => {
            const requestAndPromise: LLMRequestAndPromise = {
                request: request,
                resolve: resolve,
                reject: reject
            };

            // Insert the request into the queue based on its priority
            this.insertQueue(requestAndPromise);

            // If the queue is empty, process the request immediately
            if (this._llmQueue.length === 1) {
                return this.processNextRequest();
            }
        });

        return new LLMResponseFuture(promise);
    }

    /**
     * Processes the next request in the queue.
     * @returns The response from the LLM for the processed request.
     */
    public async processNextRequest() {
        // If the queue is empty, return an empty string
        if (this._llmQueue.length === 0) {
            return;
        }

        if (this._processing) {
            // If already processing, do not start another request
            return;
        }

        this._processing = true;
        

        // Pop the next request from the queue
        const request = this.popQueue();
        if (!request) {
            return;
        }

        // Process the request and return the response
        try {
            const response = await this.processRequest(request.request);
            // Resolve the promise with the response
            request.resolve(response);
        } catch (error: any) {
            request.reject(error);
            console.error('Error processing LLM request:', error.message);
        } finally {
            this._processing = false;
            // If there are more requests in the queue, process the next one
            if (this._llmQueue.length > 0) {
                this.processNextRequest();
            }
        }
    }


    /**
     * Adds a new request to the queue.
     * @param request The LLMRequest to add to the queue.
     */
    private insertQueue(request: LLMRequestAndPromise): void {
        // Insert the request into the queue based on its priority. Higher priority requests (higher numbers) are processed first.
        let inserted = false;
        for (let i = 0; i < this._llmQueue.length; i++) {
            if (request.request.priority > this._llmQueue[i].request.priority) {
                this._llmQueue.splice(i, 0, request);
                inserted = true;
                break;
            }
        }
        if (!inserted) {
            this._llmQueue.push(request);
        }
    }

    /**
     * Removes and returns the next request from the queue.
     * @returns The next LLMRequest or undefined if the queue is empty.
     */
    private popQueue(): LLMRequestAndPromise | undefined {
        return this._llmQueue.shift();
    }

    private async processRequest(request: LLMRequest): Promise<LLMResponse> {
        try {
            const prompt = request.prompt.generatePrompt();
            const res = await got.post(URL, {
                json: {
                    schema: request.schema,
                    input_text: prompt
                },
                timeout: {
                    request: 60000 // 60 seconds
                }
            }).json() as LLMResponse;
            if (res.error) {
                throw new Error(res.error);
            }
            return res;
        } catch (error) {
            console.error('Error fetching LLM response:', error)
            throw error
        }
    }
}