import timesfm
import pandas as pd

df = pd.read_csv('btc_data.csv')
tfm = timesfm.TimesFm(context_len=512, horizon_len=1)
tfm.fine_tune(df)
tfm.save('fine_tuned_timesfm')