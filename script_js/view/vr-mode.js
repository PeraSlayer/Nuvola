/*
===============================================================================
File: vr-mode.js

Modulo per la modalità VR usando Three.js WebXR. Permette di visualizzare
la nuvola di punti in realtà virtuale con visori compatibili (Oculus, Vive, ecc.)

Funzionalità:
- Inizializzazione sessione WebXR
- Rendering stereoscopico automatico
- Controllo camera tramite movimento testa
- Supporto controller VR (opzionale)
- Integrazione con il renderer esistente

===============================================================================
*/

import * as THREE from 'three';

export class VRMode {
  constructor(app) {
    this.app = app;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.session = null;
    this.referenceSpace = null;
    this.isActive = false;
    this.pointCloudMesh = null;
    this.controllers = [];
  }

  /**
   * Verifica se WebXR è supportato
   */
  async isSupported() {
    if (!navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-vr');
    } catch (err) {
      return false;
    }
  }

  /**
   * Inizializza la scena VR
   */
  async init() {
    if (!await this.isSupported()) {
      throw new Error('WebXR non supportato su questo dispositivo/browser');
    }

    // Crea renderer Three.js per VR
    this.renderer = new THREE.WebGLRenderer({ 
      antialias: true,
      alpha: true
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    
    // Crea scena
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    // Crea camera
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      10000
    );
    this.scene.add(this.camera);

    // Aggiungi luci
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    this.scene.add(directionalLight);

    // Inizializza controller
    this._initControllers();
  }

  /**
   * Inizializza i controller VR
   */
  _initControllers() {
    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      
      controller.addEventListener('selectstart', () => {
        this._onControllerSelect(controller);
      });
      
      controller.addEventListener('squeezestart', () => {
        this._onControllerSqueeze(controller);
      });
      
      this.scene.add(controller);
      this.controllers.push(controller);

      // Aggiungi visualizzazione del controller
      const geometry = new THREE.CylinderGeometry(0.01, 0.02, 0.1, 8);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshStandardMaterial({ 
        color: 0x00ff00,
        metalness: 0.5,
        roughness: 0.5
      });
      const mesh = new THREE.Mesh(geometry, material);
      controller.add(mesh);
    }
  }

  /**
   * Gestisce la pressione del trigger del controller
   */
  _onControllerSelect(controller) {
    console.log('Controller select:', controller);
    // Qui puoi aggiungere interazioni con la nuvola di punti
  }

  /**
   * Gestisce la pressione del grip del controller
   */
  _onControllerSqueeze(controller) {
    console.log('Controller squeeze:', controller);
    // Qui puoi aggiungere interazioni con la nuvola di punti
  }

  /**
   * Aggiorna la mesh della nuvola di punti nella scena VR
   */
  updatePointCloud() {
    if (!this.app.cloud || !this.scene) return;

    // Rimuovi mesh precedente
    if (this.pointCloudMesh) {
      this.scene.remove(this.pointCloudMesh);
      this.pointCloudMesh.geometry.dispose();
      this.pointCloudMesh.material.dispose();
    }

    const cloud = this.app.cloud;
    const positions = cloud.positions;
    const colors = cloud.colors;

    // Crea geometria
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(
      Array.from(colors).map(c => c / 255), 3
    ));

    // Crea materiale
    const material = new THREE.PointsMaterial({
      size: 0.5,
      vertexColors: true,
      sizeAttenuation: true
    });

    // Crea mesh
    this.pointCloudMesh = new THREE.Points(geometry, material);
    
    // Centra la nuvola di punti
    const center = cloud.center;
    this.pointCloudMesh.position.set(-center[0], -center[1], -center[2]);
    
    // Scala in base ai bounds
    const bounds = cloud.bounds;
    const size = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    );
    const scale = 10 / size; // Adatta alla scena VR
    this.pointCloudMesh.scale.set(scale, scale, scale);
    
    this.scene.add(this.pointCloudMesh);
  }

  /**
   * Avvia la sessione VR
   */
  async startSession() {
    if (this.isActive) return;

    try {
      if (!this.renderer) {
        await this.init();
      }

      // Richiedi sessione VR
      this.session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
      });

      // Configura renderer
      await this.renderer.xr.setSession(this.session);

      // Ottieni reference space
      this.referenceSpace = await this.session.requestReferenceSpace('local-floor');

      // Aggiorna nuvola di punti
      this.updatePointCloud();

      // Gestisci fine sessione
      this.session.addEventListener('end', () => {
        this.isActive = false;
        this.session = null;
        this.app.canvas.style.display = 'block';
        this.renderer.domElement.style.display = 'none';
      });

      // Nascondi canvas normale, mostra canvas VR
      this.app.canvas.style.display = 'none';
      this.renderer.domElement.style.display = 'block';
      
      // Aggiungi canvas VR al DOM se non presente
      if (!this.renderer.domElement.parentNode) {
        document.getElementById('main').appendChild(this.renderer.domElement);
      }

      this.isActive = true;

      // Avvia render loop VR
      this.renderer.setAnimationLoop((time, frame) => {
        this._renderLoop(time, frame);
      });

    } catch (err) {
      console.error('Failed to start VR session:', err);
      throw err;
    }
  }

  /**
   * Render loop VR
   */
  _renderLoop(time, frame) {
    if (!this.isActive || !this.session) return;

    // Aggiorna posizione camera dal tracking
    const pose = frame.getViewerPose(this.referenceSpace);
    if (pose) {
      const view = pose.views[0];
      if (view) {
        const position = view.transform.position;
        const orientation = view.transform.orientation;
        
        this.camera.position.set(position.x, position.y, position.z);
        this.camera.quaternion.set(
          orientation.x,
          orientation.y,
          orientation.z,
          orientation.w
        );
      }
    }

    // Renderizza scena
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Termina la sessione VR
   */
  async endSession() {
    if (!this.isActive || !this.session) return;

    try {
      await this.session.end();
      this.renderer.setAnimationLoop(null);
      this.isActive = false;
    } catch (err) {
      console.error('Failed to end VR session:', err);
    }
  }

  /**
   * Cleanup risorse
   */
  dispose() {
    this.endSession();
    
    if (this.pointCloudMesh) {
      this.pointCloudMesh.geometry.dispose();
      this.pointCloudMesh.material.dispose();
    }
    
    if (this.renderer) {
      this.renderer.dispose();
    }
    
    this.controllers = [];
  }
}
