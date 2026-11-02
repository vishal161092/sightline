import { LightningElement, track } from 'lwc';
import analyzeFrame from '@salesforce/apex/de_VideoReasoningController.analyzeFrame';

const SAMPLE_INTERVAL_MS = 4000; // how often we send a frame while "live"
const FRAME_MAX_DIM = 640; // downscale frames before base64 to keep payload small

export default class De_videoReasoning extends LightningElement {
    @track status = 'Tap Start to begin';
    @track guidance = '';
    @track isLive = false;
    @track isThinking = false;
    @track listening = false;

    stream;
    timer;
    recognition;
    videoEl;
    canvasEl;
    lastPrompt =
        'You are a friendly product setup assistant guiding a user through unboxing and setting up a physical product. ' +
        'Look at this live camera frame. If you can identify the product, name it and give the single most useful next setup step in one short spoken sentence. ' +
        'If you cannot see a product clearly, briefly tell the user how to position the camera. Reply with plain speakable text only.';

    renderedCallback() {
        if (!this.videoEl) {
            this.videoEl = this.template.querySelector('video');
            this.canvasEl = this.template.querySelector('canvas');
        }
    }

    disconnectedCallback() {
        this.stop();
    }

    // The click handler MUST stay synchronous up to the point where we unlock
    // speech: iOS Safari only allows speechSynthesis.speak() if it is first
    // invoked inside a real user gesture (before any await). We prime it here,
    // then hand off to the async camera flow.
    handleStart() {
        this.primeSpeech();
        this.startCamera();
    }

    // Speak a silent utterance synchronously within the tap to unlock TTS on
    // mobile Safari, so later async speak() calls (from the Apex callback) work.
    primeSpeech() {
        if (!window.speechSynthesis) {
            return;
        }
        try {
            window.speechSynthesis.cancel();
            const warm = new SpeechSynthesisUtterance(' ');
            warm.volume = 0;
            window.speechSynthesis.speak(warm);
            this.speechUnlocked = true;
        } catch (e) {
            /* ignore */
        }
    }

    async startCamera() {
        try {
            this.status = 'Requesting camera and microphone…';
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' },
                audio: false
            });
            this.videoEl.srcObject = this.stream;
            await this.videoEl.play();
            this.isLive = true;
            this.status = 'Live — point your camera at the product';
            this.speak('I can see your camera now. Point it at the product you want to set up.');
            this.timer = setInterval(() => this.sampleFrame(), SAMPLE_INTERVAL_MS);
            this.startListening();
        } catch (e) {
            this.status = 'Camera/mic error: ' + (e.message || e);
        }
    }

    stop() {
        this.isLive = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
        this.stopListening();
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        this.status = 'Stopped';
    }

    handleStop() {
        this.stop();
    }

    captureBase64() {
        const v = this.videoEl;
        if (!v || !v.videoWidth) {
            return null;
        }
        const scale = Math.min(1, FRAME_MAX_DIM / Math.max(v.videoWidth, v.videoHeight));
        const w = Math.round(v.videoWidth * scale);
        const h = Math.round(v.videoHeight * scale);
        const c = this.canvasEl;
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        const dataUrl = c.toDataURL('image/jpeg', 0.7);
        return dataUrl.split(',')[1]; // strip "data:image/jpeg;base64,"
    }

    async sampleFrame(customPrompt) {
        if (!this.isLive || this.isThinking) {
            return;
        }
        const b64 = this.captureBase64();
        if (!b64) {
            return;
        }
        this.isThinking = true;
        try {
            const res = await analyzeFrame({
                base64Image: b64,
                mimeType: 'image/jpeg',
                prompt: customPrompt || this.lastPrompt
            });
            if (res && res.success && res.text) {
                this.guidance = res.text;
                this.speak(res.text);
            } else if (res && res.error) {
                this.status = 'Model error: ' + res.error;
            }
        } catch (e) {
            this.status = 'Call failed: ' + (e.body ? e.body.message : e.message);
        } finally {
            this.isThinking = false;
        }
    }

    // ---- Voice: browser Web Speech ----
    speak(text) {
        if (!window.speechSynthesis || !text) {
            return;
        }
        const synth = window.speechSynthesis;
        synth.cancel(); // avoid overlap
        // iOS can leave the engine paused after idle — resume before speaking.
        if (synth.paused) {
            synth.resume();
        }
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0;
        u.lang = 'en-US';
        u.volume = 1.0;
        synth.speak(u);
    }

    startListening() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            return; // STT unsupported in this browser; guidance still works
        }
        this.recognition = new SR();
        this.recognition.continuous = true;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US';
        this.recognition.onresult = (event) => {
            const said = event.results[event.results.length - 1][0].transcript.trim();
            if (said) {
                this.handleUserQuestion(said);
            }
        };
        this.recognition.onend = () => {
            if (this.listening) {
                try {
                    this.recognition.start();
                } catch (e) {
                    /* already started */
                }
            }
        };
        this.listening = true;
        try {
            this.recognition.start();
        } catch (e) {
            /* ignore */
        }
    }

    stopListening() {
        this.listening = false;
        if (this.recognition) {
            try {
                this.recognition.stop();
            } catch (e) {
                /* ignore */
            }
            this.recognition = null;
        }
    }

    handleUserQuestion(question) {
        this.status = 'You asked: ' + question;
        const prompt =
            'You are a product setup assistant looking at the live camera frame. ' +
            'The user asked: "' + question + '". ' +
            'Answer helpfully in one or two short spoken sentences based on what you see. Plain speakable text only.';
        this.sampleFrame(prompt);
    }
}
