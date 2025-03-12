+++
draft = true
date = 2025-03-13T01:03:22+05:30
title = "Chapter 1: Reliable Scalable and Maintanable Applications"
description = "Short notes of Chapter 1 of book Designing Data Intensive Applications"
slug = ""
authors = ["Zuhaib Ul Zamann"]
tags = []
categories = []
externalLink = ""
series = []
+++
This post is a collection of important points i have learned while reading the book **Designing Data intensive applications**
Chapter-1 deals with basic description and explanation of what Reliability, Scalability and Maintainability mean.
## Reliability
It describes how tolerant the system is with respect to faults induced due to hardware issues/software bugs or human error. The lower the chance of cascading effect or failure of the system due to faults the more reliable the system is.

## Scalability
Scalability is the ability to easily manage the quality of the service in case the system grows along multiple parameters such as requests per second, size of data, size of network etc.
> Recommended: The book gives a very good example of a scalability problem faced at twitter. It describes two approaches which twitter followed, with analysis of pros and cons of both the approaches and how a hybrid approach proved to be the best solution.

Performance of a system is often measured by the metric the system most cares about e.g. for a webserver it would be the response time of the requests it serves. 
These metrics often form a distribution of numbers rather than a single number. Statistical values such as percentiles, mean etc of the metrics give insights about how the system is performing. System is often designed to optimize these parameters, e.g. for a webserver an engineer would like to minimize the p99 or p999 of the response times etc. 
These statistical params being indicative of the quality of service are often used in SLOs and SLAs.
> Note: The book provides an important clarification when benchmarking the service for its latency and other params at some fixed rps. Whenever load testing is performed it should be performed by the client irrespective of taking into consideration the response time per request from the server, i.e. the client should keep on sending requests independent of the response time from the server. 

During load testing teams often introduce semaphores from client side to limit the number of parallel requests made to the service hence artificially inducing smaller queues which may not be the case when the release is receiving live load. This often leads to incorrect reporting of the benchmarking results.

There are two apporaches to handling increase in scale. Scaling vertically, i.e. putting more compute and resources in a single machine or scaling horizontally i.e. distributing the load across multiple smaller machines.
**Indefinite vertical scaling is impossible hence inducing need for horizontal scaling after some point.**

## Maintainability
The easier it is to fix software bugs, adapt the software to new platforms, add new features or investigate failures of a system the more maintanable the system is

The main design principles of software systems:
- Operability: Make it easy for operation teams to keep the system operational
- Simplicity: Make it easier for new engineers to understand the system
- Evolvability: Make it easire for engineers to add on features to the system in future.

Operability involves aspects such as :
- Ease of addition of automations to the framework
- Ease of debugging faults and monitoring the system.
- Ease of ability to perform upgrades and patches 

Simplicity involves aspects such as: 
- Less coupled behaviour in modules and systems.
- Clean abstraction and the ease of replacing/changin the implementation.
- Abstraction of complex work performed under the hood\[Which can be complex for maintaining resiliency or other reasons such as interaction between various parts of the software/project\]

Evolvability involves aspsects such as:
- Ease of addition of new features to the software
- Ease of refactoring implementation details.


