Data Source
ERA5 reanalysis NetCDF file containing t2m (2-meter temperature) on a 721×1440 global grid (~0.25° resolution), with 5844 timesteps at 6-hour intervals.
Data Preparation
Spatial sampling: 2000 random grid cells are selected from the ~1M total to keep memory manageable. Each cell's full time series is extracted one-at-a-time from the lazy NetCDF variable (avoiding loading the 24 GB array).
Caching: Extracted series + normalized lat/lon are saved to a compressed .npz for instant reloads.
Fill/gap handling: Fill values (~3.4e38) are replaced with NaN and linearly interpolated.
Normalization
Z-score using global mean/std computed only on the training portion (first 75% of timesteps). Scaler is persisted to scaler.npy for inference-time denormalization.
Coordinates normalized to [-1, 1]: lat/90, lon/180 − 1.
Windowing
Input window: 28 steps = 7 days of history
Forecast horizon: 4 steps = 24 hours ahead
Sliding windows are built via np.lib.stride_tricks.as_strided (zero-copy), then lat/lon are tiled and concatenated, giving input shape (WINDOW_SIZE + 2,) = 30 features per sample.
Splits
Split	Timestep range	Purpose
Train	0 – 75%	Fit weights
Val	75% – 85%	Early stopping / LR scheduling
Test	85% – 100%	Final evaluation
Architecture — "LocCNN"
A location-conditioned 1D CNN:

Location branch: The 2 coord features → Dense(16, ReLU) → a 16-d spatial embedding.
Temporal branch: The 28 temperature steps are reshaped to (28, 1), then the location embedding is tiled across all 28 timesteps and concatenated → (28, 17). This goes through:
Conv1D(64, k=3, causal) + BN
Conv1D(64, k=3, causal) + BN
Conv1D(32, k=3, causal)
GlobalAveragePooling1D → (32,)
Decoder: Concat(pooled temporal [32], loc embedding [16]) → Dense(64, ReLU) → Dropout(0.1) → Dense(4, float32) outputting the 4-step forecast.
Key design choices:

Causal padding ensures each conv output only depends on current and past steps (no future leakage).
Location injection into every conv layer lets filters learn location-dependent temporal patterns (e.g., different diurnal cycles at different latitudes).
Mixed precision (float16 compute / float32 weights) for GPU speed.
Output layer is explicitly float32 to avoid numerical issues with mixed precision.
Training
Optimizer: Adam, lr=1e-3
Loss: MSE, Metric: MAE
Callbacks: ReduceLROnPlateau (patience=2, factor=0.5) + EarlyStopping (patience=4, restores best weights)
Batch size: 512, up to 15 epochs, ~17K train batches/epoch
Results
Metric	Value
Test RMSE	1.93 K (~1.93 °C)
Test MAE	1.21 K (~1.21 °C)
This is a solid baseline for a 24-hour global temperature forecast. The model is saved to t2m_model.keras