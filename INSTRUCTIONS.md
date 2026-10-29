# How To Use This

  The most common use case will probably be to have an LLM generate a JSON file for you in the Graph Structured Document schema.

  In chat mode with your favorite LLM, submit the following:

  ```
  Generate a JSON file in the same schema as <reference example file here> on the topic of <TOPIC>; make between 50 and 100 nodes balancing breadth and depth. Ensure the final file is proper JSON in the provided schema.
 ```

   As a structured document format, that's it --- the JSON is the product. 


## Viewing your creation

   If you want to navigate the JSON file in a UI, you can use one of the provided renderers or make your own.

   We encourage you pushing new renderers to the repo! The more innovative and insightful ways to navigate a Graph Structured Document, the better we become at sharing and presenting ideas, which is the whole motivation of this project.

   With a powerful coding assistant, a prompt such as the following is a good start:

   ```
   Generate an interactive UI allowing me to navigate a JSON file like <reference your JSON here>. It should be deployable in a web browser referencing a local port and enjoy the following features: <feature 1>, <feature 2>, ...
   ```


