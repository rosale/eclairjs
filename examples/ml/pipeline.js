/*
 * Copyright 2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

function exit() {
  process.exit();
}

function stop(e) {
  if (e) {
    console.log(e);
  }
  sc.stop().then(exit).catch(exit);
}

var spark = require('../../lib/index.js');

function run(sc) {
  return new Promise(function(resolve, reject) {
    var sqlContext = new spark.sql.SQLContext(sc);

    var schema = new spark.sql.types.StructType([
      new spark.sql.types.StructField("id", spark.sql.types.DataTypes.IntegerType, false, spark.sql.types.Metadata.empty()),
      new spark.sql.types.StructField("text", spark.sql.types.DataTypes.StringType, false, spark.sql.types.Metadata.empty()),
      new spark.sql.types.StructField("label", spark.sql.types.DataTypes.DoubleType, false, spark.sql.types.Metadata.empty())
    ]);

    // Prepare training documents, which are labeled.
    var training = sqlContext.createDataFrame([
      spark.sql.RowFactory.create(0, "a b c d e spark", 1.0),
      spark.sql.RowFactory.create(1, "b d", 0.0),
      spark.sql.RowFactory.create(2, "spark f g h", 1.0),
      spark.sql.RowFactory.create(3, "hadoop mapreduce", 0.0)
    ], schema);

    // Configure an ML pipeline, which consists of three stages: tokenizer, hashingTF, and lr.
    var tokenizer = new spark.ml.feature.Tokenizer()
      .setInputCol("text")
      .setOutputCol("words");

    tokenizer.getOutputCol().then(function(outputCol) {
      var hashingTF = new spark.ml.feature.HashingTF()
        .setNumFeatures(1000)
        .setInputCol(outputCol)
        .setOutputCol("features");

      var lr = new spark.ml.classification.LogisticRegression()
        .setMaxIter(10)
        .setRegParam(0.01);

      var pipeline = new spark.ml.Pipeline()
        .setStages([tokenizer, hashingTF, lr]);

      // Fit the pipeline to training documents.
      var model = pipeline.fit(training);

      var schema2 = new spark.sql.types.StructType([
        new spark.sql.types.StructField("id", spark.sql.types.DataTypes.IntegerType, false, spark.sql.types.Metadata.empty()),
        new spark.sql.types.StructField("text", spark.sql.types.DataTypes.StringType, false, spark.sql.types.Metadata.empty())
      ]);

      // Prepare test documents, which are unlabeled.
      var test = sqlContext.createDataFrame([
        spark.sql.RowFactory.create(4, "spark i j k"),
        spark.sql.RowFactory.create(5, "l m n"),
        spark.sql.RowFactory.create(6, "mapreduce spark"),
        spark.sql.RowFactory.create(7, "apache hadoop")
      ], schema2);

      // Make predictions on test documents.
      var predictions = model.transform(test);
      var rows = predictions.select("id", "text", "probability", "prediction").take(10).then(resolve).catch(reject);
    }).catch(reject);
  });
}

if (global.SC) {
  // we are being run as part of a test
  module.exports = run;
} else {
  var sc = new spark.SparkContext("local[*]", "Pipeline");
  run(sc).then(function(results) {
    console.log("Result:", JSON.stringify(results));
    stop();
  }).catch(stop);
}